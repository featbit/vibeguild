import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { program } from 'commander';
import {
  readSessionId,
  writeSessionId,
  drainPendingSignals,
  markWorldStarted,
  incrementDay,
  writeDailyRecord,
  readWorldState,
  appendSignal,
  writeRuntimeState,
  listTodayShifts,
  listBeings,
  createBeingDirectories,
  readEscalations,
} from './memory/store.js';
import {
  enqueueTask,
  getPendingTasks,
  getTasksByStatus,
  getTaskSummary,
  getBusyBeings,
  getAllTasks,
} from './tasks/queue.js';
import { createTaskRunner, type WorldTaskRunner } from './tasks/runner.js';
import { loadRuntimeConfig, worldPath } from './runtime/config.js';
import {
  triggerMeetupFreeze,
  triggerMeetupResume,
} from './scheduler/clock.js';
import { createWorldMcpServer } from './tools/report.js';
import { notifyDiscord, notifyDiscordRaw, notifyTask, createTaskThread, initDiscordBot, flushDiscord, updateTaskThreadWithRepo, closeTaskThread, getTaskThreadMention, getTaskThreadUrl, setPendingConfirm, getActiveThreadLinks } from './discord.js';
import type { OnMentionFn } from './discord.js';
import type { WorldSignal } from './memory/types.js';
import type { Task } from './tasks/types.js';

// ─── Orchestrator turn (assignment + human messages only) ────────────────────

type OrchestratorContext = {
  pendingTasks: Task[];
  humanMessages: string[];
  allBeings: string[];
  busyBeings: string[];
  isFirstRun: boolean;
  dayCount: number;
  signals: WorldSignal[];
};

const buildAssignmentPrompt = (ctx: OrchestratorContext): string => {
  const parts: string[] = [];

  if (ctx.isFirstRun) {
    parts.push(
      `You are the Orchestrator of Vibe Guild. The world is starting up.`,
      `Check world/memory/world.json and world/tasks/queue.json.`,
      `The being pool is empty — create beings as needed to handle tasks.`,
    );
  } else {
    parts.push(`Vibe Guild — Day ${ctx.dayCount}. Assignment turn.`);
  }

  // Being pool
  const free = ctx.allBeings.filter((b) => !ctx.busyBeings.includes(b));
  parts.push(`\n--- BEING POOL ---`);
  parts.push(`All beings: ${ctx.allBeings.length > 0 ? ctx.allBeings.join(', ') : 'none yet (will be created as needed)'}`);
  if (ctx.busyBeings.length > 0) {
    parts.push(`Busy (already on a task — do NOT assign more): ${ctx.busyBeings.join(', ')}`);
  }
  parts.push(`Free now: ${free.length > 0 ? free.join(', ') : 'none'}`);
  parts.push(``);
  parts.push(`ASSIGNMENT STRATEGY:`);
  parts.push(`  1. Use free beings first.`);
  parts.push(`  2. If not enough free beings, CREATE new ones from .claude/agents/_template.md.`);
  parts.push(`  3. No upper limit. Each being may only work on ONE task at a time.`);
  parts.push(``);
  parts.push(`CREATE NEW BEING (3 steps):`);
  parts.push(`  a. Pick a lowercase name (dana, evan, felix, grace…).`);
  parts.push(`  b. Copy .claude/agents/_template.md → fill placeholders → save as .claude/agents/{name}.md.`);
  parts.push(`  c. Write world/beings/{name}/profile.json: { id, name, role, description, skills[], status:"idle", createdAt }.`);
  parts.push(`RULE: one task per being at a time.`);
  parts.push(`---`);

  // Pending tasks
  if (ctx.pendingTasks.length > 0) {
    parts.push(`\n--- PENDING TASKS TO ASSIGN ---`);
    for (const t of ctx.pendingTasks) {
      const cap = t.maxBeings !== undefined ? ` [MAX ${t.maxBeings} beings]` : '';
      parts.push(`• [${t.priority.toUpperCase()}] ${t.id.slice(0, 8)} — ${t.title}${cap}`);
    }
    parts.push(
      `Read world/tasks/queue.json for full task details.`,
      `For each pending task:`,
      `  1. Choose the right beings (create if needed).`,
      `  2. Pick ONE being as leader — they will coordinate + write progress.json.`,
      `  3. Update the task in world/tasks/queue.json: set status="assigned", leaderId="...", assignedTo=[...].`,
      ``,
      `!! CRITICAL: Do NOT execute tasks yourself. Do NOT call APIs, write output files, or do research.`,
      `!! Your ONLY job here is to write world/tasks/queue.json with status=assigned, leaderId, assignedTo.`,
      `!! A sandbox runner will automatically start for each assigned task. The being will do the actual work.`,
      `---`,
    );
  }

  // Human messages
  if (ctx.humanMessages.length > 0) {
    parts.push(`\n--- MESSAGES FROM HUMAN OPERATOR ---`);
    for (const msg of ctx.humanMessages) parts.push(`> ${msg}`);
    parts.push(`---`, `Respond and act on these messages. Add new tasks to queue if instructed.`);
  }

  // Other signals
  const relevantSignals = ctx.signals.filter(
    (s) => !['MEETUP_FREEZE', 'SHIFT_REST_START', 'SHIFT_DAY_END'].includes(s.type),
  );
  if (relevantSignals.length > 0) {
    parts.push(`\n--- OTHER SIGNALS ---`);
    for (const s of relevantSignals) {
      parts.push(`• ${s.type}: ${JSON.stringify(s.payload ?? {})}`);
    }
  }

  return parts.join('\n');
};

// ─── World Engine ─────────────────────────────────────────────────────────────

const runWorldLoop = async (): Promise<void> => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  // ── State ────────────────────────────────────────────────────────────────
  const activeRunners = new Map<string, WorldTaskRunner>();
  let orchestratorSessionId = await readSessionId();
  let isFirstRun = !orchestratorSessionId;
  const globalHumanMessages: string[] = [];
  // Tasks frozen by a task-level meetup (not globally frozen)
  const frozenTaskIds: string[] = [];
  let frozen = false;       // true during global meetup
  let resting = false;      // true between SHIFT_REST_START and SHIFT_DAY_END
  let schedulerBusy = false;
  let orchestratorBusy = false; // true while SDK assignment call is in-flight

  /**
   * When non-null, the user is in an alignment dialogue with this task.
   * All plain terminal input is routed directly to that task's inbox instead
   * of being treated as an Orchestrator message.
   */
  let aligningTaskId: string | null = null;

  // Shared base options for all query() calls
  const mcpServer = await createWorldMcpServer();
  const baseOptions: Record<string, unknown> = {
    // Orchestrator only reads/writes world state — no Bash, no web, no task execution.
    allowedTools: ['Read', 'Write'],
    settingSources: ['project'],
    permissionMode: 'bypassPermissions',
    ...(process.env.ANTHROPIC_MODEL_ID ? { model: process.env.ANTHROPIC_MODEL_ID } : {}),
    ...(mcpServer ? { mcpServers: { 'vibe-guild-world-tools': mcpServer } } : {}),
  };

  // Options for TaskRunner instances
  const runnerOpts = {
    mcpServer,
    modelId: process.env.ANTHROPIC_MODEL_ID,
    // Track which tasks have had their repo URL posted to Discord (to post only once)
    _seenRepoUrls: new Set<string>(),
    // Track which tasks have had their final output summary posted (to post only once)
    _seenFinalOutput: new Set<string>(),
    onProgress: (p: import('./runtime/adapter.js').SyncedProgress) => {
      const short = p.taskId.slice(0, 8);
      const pct = p.percentComplete ?? 0;
      const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
      const latest = Array.isArray(p.checkpoints) && p.checkpoints.length > 0
        ? p.checkpoints[p.checkpoints.length - 1]
        : null;
      const latestMsg = latest
        ? (typeof latest === 'object' ? (latest as Record<string,unknown>)['message'] ?? (latest as Record<string,unknown>)['description'] ?? '' : '')
        : '';
      console.log(`\n📍 [${p.leaderId}→${short}] ${bar} ${pct}% — ${p.summary}`);
      if (latestMsg) console.log(`     ↳ ${latestMsg}`);
      notifyTask(p.taskId, `📍 [${p.leaderId}→${short}] ${pct}% — ${p.summary}${latestMsg ? `\n   ↳ ${latestMsg}` : ''}`);

      // Post GitHub repo URL to the task thread exactly once
      if (p.sandboxRepoUrl && !runnerOpts._seenRepoUrls.has(p.taskId)) {
        runnerOpts._seenRepoUrls.add(p.taskId);
        updateTaskThreadWithRepo(p.taskId, p.sandboxRepoUrl);
      }

      // Enter alignment mode when leader needs human input.
      // Do NOT docker-pause the container — entrypoint is actively polling inbox.
      // All terminal input will be routed directly to this task's inbox until
      // the leader resumes on its own (writes status != 'waiting_for_human').
      if (p.status === 'waiting_for_human' && aligningTaskId !== p.taskId) {
        aligningTaskId = p.taskId;
        const question = p.question ?? p.summary;
        console.log(`\n🤔 [${p.leaderId}→${short}] Leader needs your input:`);
        console.log(`   "${question}"`);
        console.log(`   ► Type your reply (press Enter to send). Type /done to let leader proceed independently.\n`);
        notifyTask(p.taskId, `🤔 [${p.leaderId}→${short}] Leader needs input:\n   "${question}"`);
      } else if (p.status === 'waiting_for_human' && aligningTaskId === p.taskId) {
        // Already in alignment mode — leader wrote a new waiting_for_human (acknowledgment or follow-up)
        const question = p.question ?? p.summary;
        console.log(`\n💬 [${p.leaderId}] ${question}`);
        console.log(`   ► Your reply:\n`);
        notifyTask(p.taskId, `💬 [${p.leaderId}] ${question}`);
      }

      // Auto-exit alignment mode when leader resumes on its own
      if (aligningTaskId === p.taskId && p.status !== 'waiting_for_human') {
        aligningTaskId = null;
        console.log(`\n✅ [${p.leaderId}→${short}] Leader alignment resolved. Resuming task.\n`);
        notifyTask(p.taskId, `✅ [${p.leaderId}→${short}] Alignment resolved. Resuming task.`);
      }

      // Post final output summary when the task is done
      if ((p.status === 'completed' || p.status === 'failed') && !runnerOpts._seenFinalOutput.has(p.taskId)) {
        runnerOpts._seenFinalOutput.add(p.taskId);
        // Update the thread title with ✅ / ❌
        void closeTaskThread(p.taskId, p.status);
        const emoji = p.status === 'completed' ? '🎉' : '💀';
        const label = p.status === 'completed' ? 'Task completed' : 'Task failed';
        const lines: string[] = [`${emoji} **${label}**`];
        if (p.summary) lines.push(`> ${p.summary}`);
        if (Array.isArray(p.checkpoints) && p.checkpoints.length > 0) {
          const recent = p.checkpoints.slice(-5);
          lines.push('**Steps:**');
          for (const cp of recent) {
            const desc = (cp as Record<string, unknown>)['description'] as string | undefined;
            if (desc) lines.push(`• ${desc}`);
          }
        }
        if (p.sandboxRepoUrl) lines.push(`🔗 ${p.sandboxRepoUrl}`);
        notifyTask(p.taskId, lines.join('\n'));
      }
    },
    onComplete: (taskId: string) => { activeRunners.delete(taskId); },
    onError: (taskId: string) => { activeRunners.delete(taskId); },
    onLog: (msg: string, taskId: string) => { notifyDiscord(msg); notifyTask(taskId, msg); },
  };

  // ── Graceful shutdown: flush Discord before exit ─────────────────────────
  const onExit = () => { void flushDiscord().finally(() => process.exit(0)); };
  process.once('SIGINT', onExit);
  process.once('SIGTERM', onExit);

  // ── Startup ──────────────────────────────────────────────────────────────
  await markWorldStarted();
  // Clock removed — world days are lightweight chronology metadata, not execution constraints.
  // See WORLD-DESIGN.md § Time Semantics.

  const initialBeings = await listBeings();
  const state = await readWorldState();
  const runtimeMode = process.env['RUNTIME_MODE'] ?? 'local';
  const modelId = process.env['ANTHROPIC_MODEL_ID'] ?? 'default';
  const dockerImage = process.env['SANDBOX_DOCKER_IMAGE'] ?? 'vibeguild-sandbox';
  console.log(`\n🌍 Vibe Guild is alive. Day ${state.dayCount} starting.`);
  console.log(`   Beings    : ${initialBeings.length > 0 ? initialBeings.join(', ') : 'none yet'}`);
  console.log(`   Runtime   : ${runtimeMode}${runtimeMode === 'docker' ? ` (image: ${dockerImage})` : ' (in-process SDK)'}`);
  console.log(`   Model     : ${modelId}`);
  console.log(`   World day : ${state.dayCount}  |  tasks: ${(await getAllTasks()).length}\n`);
  {
    const beingsList = initialBeings.length > 0 ? initialBeings.join(', ') : 'none yet';
    const taskCount = (await getAllTasks()).length;
    notifyDiscord(
      `🌍 Vibe Guild alive — Day ${state.dayCount}\n` +
      `   Beings  : ${beingsList}\n` +
      `   Runtime : ${runtimeMode}${runtimeMode === 'docker' ? ` (${dockerImage})` : ''}\n` +
      `   Model   : ${modelId} | tasks: ${taskCount}`,
    );
  }

  // ── Recover in-progress tasks from a previous run ────────────────────────
  {
    const savedTasks = await getAllTasks();
    const recovering = savedTasks.filter((t) => t.status === 'in-progress' && t.assignedTo?.length);
    for (const task of recovering) {
      console.log(`\n♻️  [World] Recovering task ${task.id.slice(0, 8)}: "${task.title}"`);
      notifyDiscord(`♻️  [World] Recovering task ${task.id.slice(0, 8)}\n   "${task.title.slice(0, 72)}"\n   leader: ${task.leaderId ?? '?'}`);
      void createTaskThread(task);
      const runner = createTaskRunner(task, runnerOpts);
      activeRunners.set(task.id, runner);
      void runner.start(task);
    }
  }

  // ── Command processor (shared by stdin and Discord bot) ───────────────────
  const processLine = (line: string): void => {
    const input = line.trim();
    if (!input) return;

    // /done or /resume — end meetup
    if (input === '/done' || input === '/resume') {
      // If in alignment mode, send a "proceed" message and exit alignment
      if (aligningTaskId) {
        const tid = aligningTaskId;
        aligningTaskId = null;
        const runner = activeRunners.get(tid);
        if (runner) {
          runner.injectMessage(
            '[Operator ended alignment] Proceed with your best judgment based on the conversation so far.',
          );
          console.log(`\n▶️  Alignment ended for task ${tid.slice(0, 8)}. Leader will proceed independently.\n`);
        }
        return;
      }
      if (frozenTaskIds.length > 0) {
        // Resume task-specific frozen runners
        void (async () => {
          const tasks = await getAllTasks();
          for (const taskId of frozenTaskIds.splice(0)) {
            const runner = activeRunners.get(taskId);
            const task = tasks.find((t) => t.id === taskId);
            if (runner && task) runner.resume(task);
          }
          console.log(`\n▶️  Task meetup ended. Runner(s) resuming.\n`);
        })();
      } else {
        frozen = false;
        void writeRuntimeState({ frozen: false, resting });
        void triggerMeetupResume();
        void (async () => {
          const tasks = await getAllTasks();
          for (const [taskId, runner] of activeRunners) {
            if (runner.isPaused && !frozenTaskIds.includes(taskId)) {
              const task = tasks.find((t) => t.id === taskId);
              if (task) runner.resume(task);
            }
          }
          console.log(`\n▶️  Global meetup ended. All beings resuming work.\n`);
        })();
      }
      return;
    }

    // /tasks — list all tasks with short IDs
    if (input.trim() === '/tasks') {
      void (async () => {
        const tasks = await getAllTasks();
        if (tasks.length === 0) { notifyDiscord('📋 No tasks yet.'); return; }
        const lines = tasks.map((t) => {
          const ageMs = Date.now() - new Date(t.createdAt).getTime();
          const ageSec = Math.floor(ageMs / 1000);
          const age = ageSec < 60 ? `${ageSec}s` : ageSec < 3600 ? `${Math.floor(ageSec/60)}m` : `${Math.floor(ageSec/3600)}h${Math.floor((ageSec%3600)/60)}m`;
          const status = t.status.padEnd(10);
          const threadUrl = getTaskThreadUrl(t.id);
          const threadMention = getTaskThreadMention(t.id);
          const threadPart = threadUrl ? `  \u2192 [thread](${threadUrl})` : threadMention ? `  \u2192 ${threadMention}` : '';
          return `\`${t.id.slice(0, 8)}\`  [${status.trim()}]  ${age}  ${t.title.slice(0, 50)}${threadPart}`;
        });
        notifyDiscordRaw(`**\ud83d\udccb Tasks (${tasks.length})**\n${lines.join('\n')}\n\n\ud83d\udc49 Click a thread link to reply in context.`);
      })();
      return;
    }

    // /status <id> — query task status and reply to Discord
    if (input.startsWith('/status ')) {
      const idPrefix = input.slice(8).trim();
      void (async () => {
        const tasks = await getAllTasks();
        const task = tasks.find((t) => t.id === idPrefix || t.id.startsWith(idPrefix));
        if (!task) {
          notifyDiscord(`⚠️ No task found matching "${idPrefix}"`);
          return;
        }
        const cfg = loadRuntimeConfig();
        const progressPath = join(worldPath(cfg), 'tasks', task.id, 'progress.json');
        let progress: { status?: string; percentComplete?: number; summary?: string; checkpoints?: Array<{ at?: string; description?: string }> } = {};
        try { progress = JSON.parse(await readFile(progressPath, 'utf-8')); } catch { /* no progress yet */ }
        const ageMs = Date.now() - new Date(task.createdAt).getTime();
        const ageSec = Math.floor(ageMs / 1000);
        const ageStr = ageSec < 60 ? `${ageSec}s` : ageSec < 3600 ? `${Math.floor(ageSec / 60)}m${ageSec % 60}s` : `${Math.floor(ageSec / 3600)}h${Math.floor((ageSec % 3600) / 60)}m`;
        const latestCheckpoint = progress.checkpoints?.at(-1);
        const threadMention = getTaskThreadMention(task.id);
        const threadUrl = getTaskThreadUrl(task.id);
        const lines = [
          `**\ud83d\udcca Task \`${task.id.slice(0, 8)}\` \u2014 ${task.status}**`,
          `> title   : ${task.title.slice(0, 80)}`,
          `> leader  : ${task.leaderId ?? '?'}  |  age: ${ageStr}  |  ${progress.percentComplete ?? 0}% done`,
          ...(progress.summary ? [`> summary : ${progress.summary.slice(0, 200)}`] : []),
          ...(latestCheckpoint ? [`> latest  : ${latestCheckpoint.description ?? ''}`] : []),
          ...(task.sandboxRepoUrl ? [`> repo    : ${task.sandboxRepoUrl}`] : []),
          ...(threadUrl ? [`> thread  : [Open thread \u2192](${threadUrl})`] : threadMention ? [`> thread  : ${threadMention}`] : []),
        ];
        notifyDiscordRaw(lines.join('\n'));
      })();
      return;
    }

    // /task <desc> — quick-add task from terminal
    if (input.startsWith('/task ')) {
      const desc = input.slice(6).trim();
      void enqueueTask({ title: desc, description: desc, createdBy: 'human' }).then((task) => {
        console.log(`\n📋 Task added: ${task.id}\n`);
        notifyDiscord(`📋 Task added: ${task.id.slice(0, 8)}\n   "${desc.slice(0, 120)}"`);
        void appendSignal('TASK_ADDED', { taskId: task.id });
      });
      return;
    }

    // /msg --task <id> <message> — inject message into a specific runner
    const taskMsgMatch = input.match(/^\/msg --task ([a-f0-9-]+) (.+)$/);
    if (taskMsgMatch) {
      const [, taskId, msg] = taskMsgMatch;
      const runner = activeRunners.get(taskId);
      if (runner) {
        runner.injectMessage(msg);
        console.log(`\n💬 Message queued for task ${taskId.slice(0, 8)}\n`);
      } else {
        // Try prefix match
        const fullId = [...activeRunners.keys()].find((id) => id.startsWith(taskId));
        if (fullId) {
          activeRunners.get(fullId)!.injectMessage(msg);
          console.log(`\n💬 Message queued for task ${fullId.slice(0, 8)}\n`);
        } else {
          console.log(`\n⚠️  No active runner for task ${taskId.slice(0, 8)}\n`);
        }
      }
      return;
    }

    // /pause --task <id> [optional message] — request alignment with a specific task
    // Does NOT docker-pause the container. Instead injects a MEETUP REQUEST into
    // the leader's inbox so it can finish its current tool call, stop gracefully,
    // and enter a multi-turn alignment conversation with the creator.
    const taskPauseMatch = input.match(/^\/pause --task ([a-f0-9-]+)(.*)?$/);
    if (taskPauseMatch) {
      const [, rawId, rest] = taskPauseMatch;
      const creatorMsg = rest?.trim() ?? '';
      const fullId = activeRunners.has(rawId)
        ? rawId
        : [...activeRunners.keys()].find((id) => id.startsWith(rawId));
      if (fullId) {
        const runner = activeRunners.get(fullId)!;
        if (!runner.isFinished) {
          const meetupMsg = [
            `[MEETUP REQUEST] The creator wants to align with you.`,
            `Please stop all current work immediately.`,
            `Write progress.json with status="waiting_for_human", a brief summary of what you were doing, and a "question" field acknowledging you are ready to align.`,
            `Then wait — do not continue the task until the creator says so.`,
            ...(creatorMsg ? [`Creator's initial message: ${creatorMsg}`] : []),
          ].join(' ');
          runner.injectMessage(meetupMsg);
          // Write pause.signal so the entrypoint's concurrent poller can kill Claude
          // immediately — no reliance on the LLM reading and obeying the inbox message.
          void (async () => {
            const cfg = loadRuntimeConfig();
            const taskDir = join(worldPath(cfg), 'tasks', fullId);
            await mkdir(taskDir, { recursive: true });
            await writeFile(
              join(taskDir, 'pause.signal'),
              JSON.stringify({ requestedAt: new Date().toISOString(), message: creatorMsg || 'Creator requested alignment' }, null, 2),
              'utf-8',
            );
          })().catch(() => undefined);
          aligningTaskId = fullId;
          console.log(`\n⏸  Task ${fullId.slice(0, 8)}: meetup request sent to leader.`);
          console.log(`   Leader will stop at its next checkpoint and come align with you.`);
          console.log(`   Type your messages directly. Type /done when you're done.\n`);
        } else {
          console.log(`\n⚠️  Task ${fullId.slice(0, 8)} is already finished.\n`);
        }
      } else {
        console.log(`\n⚠️  No active runner found for task ${rawId}\n`);
      }
      return;
    }

    // When in alignment mode, all free-form input goes to the task's inbox
    if (aligningTaskId) {
      const runner = activeRunners.get(aligningTaskId);
      if (runner) {
        runner.injectMessage(input);
        console.log(`\n💬 [→ task ${aligningTaskId.slice(0, 8)}] ${input}\n`);
      } else {
        aligningTaskId = null;
        console.log(`\n⚠️  Alignment task no longer active. Exiting alignment mode.\n`);
      }
      return;
    }

    // Default: global human message → next Orchestrator assignment turn
    globalHumanMessages.push(input);
    console.log(`\n💬 Message queued for Orchestrator (next assignment tick)\n`);
  };

  // ── Claude-powered @mention handler ─────────────────────────────────────
  const handleMention: OnMentionFn = async (text, username, userId, channelId, reply): Promise<void> => {
    const cfg = loadRuntimeConfig();
    const apiKey = cfg.anthropicApiKey;
    if (!apiKey) {
      await reply('❌ ANTHROPIC_API_KEY not set — cannot process natural language.');
      return;
    }
    const baseUrl = cfg.anthropicBaseUrl
      ? cfg.anthropicBaseUrl.replace(/\/$/, '')
      : 'https://api.anthropic.com';
    const model = cfg.anthropicModel || 'claude-haiku-4-5';

    // Build rich task context for Claude
    const allTasks = await getAllTasks();
    const now = Date.now();
    const taskLines = allTasks.length === 0
      ? '  (no tasks yet)'
      : allTasks.map((t) => {
          const ageMs = now - new Date(t.createdAt ?? now).getTime();
          const ageH  = Math.round(ageMs / 36e5);
          const age   = ageH < 1 ? 'just now' : ageH < 24 ? `${ageH}h ago` : `${Math.round(ageH / 24)}d ago`;
          const short = t.id.slice(0, 8);
          const leader = (t as Record<string, unknown>)['leader'] as string | undefined;
          const prog = (t as Record<string, unknown>)['progress'] as string | undefined;
          const leaderTag = leader ? ` [${leader}]` : '';
          const progTag = prog ? ` — ${prog.slice(0, 80)}` : '';
          return `  ${short} [${t.status}]${leaderTag} "${(t.title ?? '').slice(0, 70)}" (${age})${progTag}`;
        }).join('\n');

    const threadLines = getActiveThreadLinks().map((th) =>
      `  ${th.short} → ${th.url ?? th.mention} "${th.title.slice(0, 60)}"`
    ).join('\n') || '  (no active threads)';

    const systemPrompt = [
      'You are the Vibe Guild operator assistant bot.',
      'Vibe Guild is an autonomous AI world where Claude AI agents (called "beings") run tasks in isolated Docker containers.',
      'You help the human operator manage the world through Discord @mentions.',
      '',
      '## Available Commands (you can trigger these)',
      '- `/tasks` — list all tasks with status, progress, and Discord thread links',
      '- `/status <8-char-id>` — detailed progress snapshot for a specific task',
      '- `/task <full description>` — create a NEW task (ALWAYS ask for confirmation first)',
      '- `/pause --task <8-char-id> [message]` — pause a running task for alignment/conversation',
      '- `/msg --task <8-char-id> <message>` — inject a message into a running task',
      '- `/done` — end alignment mode, let the leader continue independently',
      '',
      '## Current World State',
      `Tasks (${allTasks.length} total):`,
      taskLines,
      '',
      'Active Discord threads:',
      threadLines,
      '',
      '## Response Instructions',
      '- Understand the human\'s intent in ANY language (Chinese or English)',
      '- Reason from the task data above to answer questions DIRECTLY without always running commands',
      '- Only put commands in the "commands" array when an action is truly needed',
      '- For creating tasks: ALWAYS set needsConfirmation=true — never create silently',
      '- Respond in the SAME language the human used',
      '- Be conversational, warm, concise — like a helpful team member, not a robot',
      '- If unsure what task they mean, ask a clarifying question instead of guessing',
      '',
      'Respond ONLY with valid JSON (no markdown wrapper):',
      '{',
      '  "reply": "message to send immediately (markdown ok, keep ≤400 chars)",',
      '  "commands": ["optional command strings"],',
      '  "needsConfirmation": false,',
      '  "confirmDescription": "only set when needsConfirmation is true"',
      '}',
    ].join('\n');

    interface AnthropicResponse {
      content: Array<{ type: string; text: string }>;
    }

    interface MentionResult {
      reply: string;
      commands: string[];
      needsConfirmation?: boolean;
      confirmDescription?: string;
    }

    let result: MentionResult = { reply: '', commands: [] };

    try {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: `${username}: ${text}` }],
        }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        await reply(`❌ AI 服务错误 (${res.status}): ${errBody.slice(0, 200)}`);
        return;
      }

      const data = await res.json() as AnthropicResponse;
      const rawText = data.content.find((b) => b.type === 'text')?.text ?? '{}';

      // Strip markdown code fence if present
      const jsonStr = rawText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();

      try {
        result = JSON.parse(jsonStr) as MentionResult;
      } catch {
        // Claude returned plain text instead of JSON — treat as reply
        result = { reply: rawText.slice(0, 400), commands: [] };
      }
    } catch (err) {
      await reply(`❌ 网络错误：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // 1. Send immediate reply
    if (result.reply) {
      await reply(result.reply);
    }

    // 2. If confirmation needed, register pending and stop
    if (result.needsConfirmation) {
      const desc = result.confirmDescription ?? result.commands.join(', ');
      setPendingConfirm(channelId, { commands: result.commands ?? [], description: desc, userId });
      return;
    }

    // 3. Execute commands
    for (const cmd of (result.commands ?? [])) {
      if (cmd.startsWith('/')) {
        console.log(`\n📨 [Discord AI] executing: ${cmd}`);
        processLine(cmd);
      }
    }
  };

  // ── Stdin (human operator) ───────────────────────────────────────────────
  process.stdin.resume();
  const stdinRl = createInterface({ input: process.stdin });
  stdinRl.on('line', processLine);

  // ── Discord bot (optional, bidirectional) ────────────────────────────────
  initDiscordBot(processLine, handleMention);

  // ── Scheduler tick (every 5 s) ───────────────────────────────────────────
  const tick = async (): Promise<void> => {
    if (schedulerBusy) return;
    schedulerBusy = true;
    try { await processTick(); }
    finally { schedulerBusy = false; }
  };

  const processTick = async (): Promise<void> => {
    const signals = await drainPendingSignals();

    // ── Global meetup freeze ──────────────────────────────────────────────
    const globalFreeze = signals.find(
      (s) => s.type === 'MEETUP_FREEZE' && !(s.payload as Record<string, unknown>)?.['taskId'],
    );
    if (globalFreeze) {
      frozen = true;
      void writeRuntimeState({ frozen: true, resting });
      for (const runner of activeRunners.values()) {
        if (runner.isRunning) runner.pause();
      }
      console.log(`\n❄️  World frozen for global meetup.`);
      console.log(`   Type messages in this terminal. Type /done to resume.\n`);
    }

    // ── Task-level meetup freeze ──────────────────────────────────────────
    const taskFreeze = signals.find(
      (s) => s.type === 'MEETUP_FREEZE' && (s.payload as Record<string, unknown>)?.['taskId'],
    );
    if (taskFreeze) {
      const taskId = (taskFreeze.payload as Record<string, unknown>)['taskId'] as string;
      // Support short IDs
      const fullId = activeRunners.has(taskId)
        ? taskId
        : [...activeRunners.keys()].find((id) => id.startsWith(taskId));
      if (fullId) {
        const runner = activeRunners.get(fullId)!;
        if (runner.isRunning) runner.pause();
        frozenTaskIds.push(fullId);
        console.log(`\n❄️  Task ${fullId.slice(0, 8)} frozen.`);
        console.log(`   Use: /msg --task ${fullId.slice(0, 8)} <message>`);
        console.log(`   Type /done to resume.\n`);
      } else {
        console.log(`\n⚠️  Freeze requested for unknown task: ${taskId}\n`);
      }
    }

    // ── Rest start (soft signal) ──────────────────────────────────────────
    const restSignal = signals.find((s) => s.type === 'SHIFT_REST_START');
    if (restSignal && !resting) {
      resting = true;
      void writeRuntimeState({ frozen, resting: true });
      const dayCount = (await readWorldState()).dayCount;
      const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
      const restMsg =
        `REST PERIOD — Day ${dayCount}. ` +
        `At your next convenient stopping point (between tool calls, not mid-operation): ` +
        `(1) write a progress checkpoint to world/tasks/${'{taskId}'}/progress.json, ` +
        `(2) write a shift summary to world/beings/${'{leaderId}'}/memory/shifts/${ts}.json. ` +
        `Then CONTINUE your work — do NOT stop or wait.`;
      let injected = 0;
      for (const [taskId, runner] of activeRunners) {
        const task = (await getAllTasks()).find((t) => t.id === taskId);
        if (!task) continue;
        const msg = restMsg
          .replace('{taskId}', taskId)
          .replace('{leaderId}', task.leaderId ?? task.assignedTo?.[0] ?? 'leader');
        runner.injectMessage(msg);
        injected++;
      }
      console.log(`\n⏸  [World] Rest signal sent to ${injected} active runner(s). Runners continue working.`);
    }

    // ── Day end ───────────────────────────────────────────────────────────
    const dayEndSignal = signals.find((s) => s.type === 'SHIFT_DAY_END');
    if (dayEndSignal) {
      const worldState = await incrementDay();
      const today = new Date().toISOString().slice(0, 10);
      const allBeings = await listBeings();
      // Collect beings that wrote a shift file today (best-effort, may lag slightly)
      const beingsWithShifts: string[] = [];
      for (const b of allBeings) {
        const shifts = await listTodayShifts(b, today);
        if (shifts.length > 0) beingsWithShifts.push(b);
      }
      const escalations = await readEscalations();
      const todayEscalations = escalations.filter((e) => e.createdAt.startsWith(today));
      const inProgress = await getTasksByStatus('in-progress');
      await writeDailyRecord({
        date: today,
        dayCount: worldState.dayCount,
        beingsActive: beingsWithShifts.length > 0 ? beingsWithShifts : allBeings,
        tasksCompleted: worldState.completedProjects ?? [],
        tasksInProgress: inProgress.map((t) => t.id),
        escalationCount: todayEscalations.length,
        keyEvents: [`Day ${worldState.dayCount} ended at ${new Date().toISOString()}`],
        writtenAt: new Date().toISOString(),
      });
      // Runners were never paused — just clear the resting flag for status display
      if (resting) {
        resting = false;
        void writeRuntimeState({ frozen, resting: false });
        console.log(`\n🌄 [World] Day ${worldState.dayCount} starting. Daily record written. Runners continue.`);
      }
    }

    // ── Skip work only during a hard meetup freeze ────────────────────────
    if (frozen) return;

    // ── Scaffold new being directories (idempotent) ───────────────────────
    const allBeings = await listBeings();
    await Promise.all(allBeings.map((id) => createBeingDirectories(id)));

    // ── Start runners for newly assigned tasks ────────────────────────────
    const assignedTasks = await getTasksByStatus('assigned');
    for (const task of assignedTasks) {
      if (!activeRunners.has(task.id) && task.assignedTo?.length) {
        // Ensure being directories exist before the sandbox starts writing to them
        await Promise.all((task.assignedTo ?? []).map((id) => createBeingDirectories(id)));
        const cfg2 = loadRuntimeConfig();
        const ageMs = Date.now() - new Date(task.createdAt).getTime();
        const ageSec = Math.floor(ageMs / 1000);
        const ageStr = ageSec < 60 ? `${ageSec}s` : `${Math.floor(ageSec / 60)}m${ageSec % 60}s`;
        console.log(`\n🚀 [World] Starting runner — task ${task.id.slice(0, 8)}`);
        console.log(`   Title    : ${task.title.slice(0, 72)}`);
        console.log(`   Leader   : ${task.leaderId ?? '?'}  |  team: ${(task.assignedTo ?? []).join(', ')}`);
        console.log(`   Priority : ${task.priority}  |  age: ${ageStr}`);
        console.log(`   Mode     : ${cfg2.mode}${cfg2.mode === 'docker' ? ` (image: ${cfg2.dockerImage}, exec: ${cfg2.executionMode})` : ' (local SDK)'}`);
        notifyDiscord(`🚀 [World] Task started: ${task.id.slice(0, 8)}\n   "${task.title.slice(0, 72)}"\n   leader: ${task.leaderId ?? '?'}  priority: ${task.priority}`);
        void createTaskThread(task);
        const runner = createTaskRunner(task, runnerOpts);
        activeRunners.set(task.id, runner);
        void runner.start(task);
      }
    }

    // ── Orchestrator assignment turn (only when needed) ───────────────────
    const pendingTasks = await getPendingTasks();
    const needsAssignment =
      pendingTasks.length > 0 ||
      globalHumanMessages.length > 0 ||
      isFirstRun ||
      signals.some((s) => s.type === 'TASK_ADDED');

    if (!needsAssignment) return;

    // Skip if an SDK call is already in-flight — runners are unblocked every tick regardless.
    // Messages are NOT spliced yet so they survive to the next tick instead of being silently dropped.
    if (orchestratorBusy) return;

    const messagesForThisTurn = globalHumanMessages.splice(0);
    orchestratorBusy = true;

    // ── Fire-and-forget: orchestrator SDK call must NOT block the tick loop ──
    // Runner starts (above) happen every 5 s; the SDK may take 30 s – 5 min.
    void (async () => {
      try {
        const [busyBeings, worldState] = await Promise.all([getBusyBeings(), readWorldState()]);

        // ── Log assignment turn context ─────────────────────────────────────
        const freeBeings = allBeings.filter((b) => !busyBeings.includes(b));
        console.log(`\n🧠 [Orchestrator] Assignment turn — Day ${worldState.dayCount}`);
        if (pendingTasks.length > 0) {
          console.log(`   Pending tasks (${pendingTasks.length}):`);
          for (const t of pendingTasks) {
            const ageMs = Date.now() - new Date(t.createdAt).getTime();
            const ageStr = ageMs < 60_000 ? `${Math.floor(ageMs / 1000)}s` : `${Math.floor(ageMs / 60_000)}m`;
            console.log(`     • ${t.id.slice(0, 8)}  [${t.priority}]  age:${ageStr}  ${t.title.slice(0, 55)}`);
          }
        }
        if (messagesForThisTurn.length > 0) {
          console.log(`   Human messages: ${messagesForThisTurn.length}`);
        }
        console.log(`   Beings free: ${freeBeings.length > 0 ? freeBeings.join(', ') : 'none'}  |  busy: ${busyBeings.length > 0 ? busyBeings.join(', ') : 'none'}`);
        console.log(`   Calling SDK…`);
        {
          const taskLines = pendingTasks.map((t) => {
            const ageMs = Date.now() - new Date(t.createdAt).getTime();
            const ageStr = ageMs < 60_000 ? `${Math.floor(ageMs / 1000)}s` : `${Math.floor(ageMs / 60_000)}m`;
            return `  • ${t.id.slice(0, 8)} [${t.priority}] age:${ageStr} ${t.title.slice(0, 50)}`;
          });
          notifyDiscord(
            `🧠 [Orchestrator] Assignment turn — Day ${worldState.dayCount}\n` +
            (pendingTasks.length > 0 ? `Pending tasks (${pendingTasks.length}):\n${taskLines.join('\n')}\n` : '') +
            `Beings free: ${freeBeings.length > 0 ? freeBeings.join(', ') : 'none'}  |  busy: ${busyBeings.length > 0 ? busyBeings.join(', ') : 'none'}`,
          );
        }

        const prompt = buildAssignmentPrompt({
          pendingTasks,
          humanMessages: messagesForThisTurn,
          allBeings,
          busyBeings,
          isFirstRun,
          dayCount: worldState.dayCount,
          signals,
        });

        isFirstRun = false;

        const abortCtrl = new AbortController();
        const orchOptions = {
          ...baseOptions,
          maxTurns: 10,
          abortController: abortCtrl,
          ...(orchestratorSessionId ? { resume: orchestratorSessionId } : {}),
        } as Parameters<typeof query>[0]['options'];

        const ORCHESTRATOR_TURN_TIMEOUT_MS = 120_000;
        const timeout = setTimeout(() => {
          abortCtrl.abort();
          console.warn(`\n[Orchestrator] Assignment turn timed out after ${ORCHESTRATOR_TURN_TIMEOUT_MS / 1000}s; will retry next tick.`);
        }, ORCHESTRATOR_TURN_TIMEOUT_MS);

        try {
          for await (const msg of query({ prompt, options: orchOptions })) {
            const m = msg as Record<string, unknown>;
            if (m['type'] === 'system' && m['subtype'] === 'init' && m['session_id']) {
              orchestratorSessionId = m['session_id'] as string;
              void writeSessionId(orchestratorSessionId);
            }
            if (m['type'] === 'assistant' && Array.isArray(m['content'])) {
              for (const block of m['content'] as Array<Record<string, unknown>>) {
                if (block['type'] === 'text' && block['text']) {
                  const text = block['text'] as string;
                  process.stdout.write(`\n[Orchestrator] ${text}\n`);
                  notifyDiscord(`🧠 [Orchestrator]\n${text}`);
                }
              }
            }
            if (m['result']) {
              // Show newly assigned tasks after this turn
              const nowAssigned = await getTasksByStatus('assigned');
              const fresh = nowAssigned.filter((t) => !assignedTasks.some((a) => a.id === t.id));
              if (fresh.length > 0) {
                console.log(`\n📋 [Orchestrator] Assigned ${fresh.length} task(s) this turn:`);
                for (const t of fresh) {
                  console.log(`     • ${t.id.slice(0, 8)}  leader:${t.leaderId ?? '?'}  team:[${(t.assignedTo ?? []).join(', ')}]  "${t.title.slice(0, 55)}"`);
                }
                notifyDiscord(`📋 [Orchestrator] Assigned ${fresh.length} task(s):\n` +
                  fresh.map((t) => `  • ${t.id.slice(0, 8)} leader:${t.leaderId ?? '?'} "${t.title.slice(0, 55)}"`).join('\n'));
              } else {
                process.stdout.write(`\n[Orchestrator] Assignment turn complete (no new assignments).\n`);
              }
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!/abort/i.test(message)) {
            console.error(`\n[Orchestrator] Error: ${message}\n`);
          }
        } finally {
          clearTimeout(timeout);
        }
      } finally {
        orchestratorBusy = false;
      }
    })();
  };

  setInterval(() => { void tick(); }, 5_000);
  void tick(); // run immediately on startup
};

// ─── commands ─────────────────────────────────────────────────────────────────

program
  .name('vibe-guild')
  .description('Vibe Guild — autonomous AI world for FeatBit vibe marketing')
  .version('0.1.0');

program
  .command('start')
  .description('Start the world — scheduler runs every 5s, tasks run in parallel')
  .action(() => { void runWorldLoop(); });

program
  .command('task <description>')
  .description('Add a task to the world task queue')
  .option('-p, --priority <priority>', 'Priority: low | normal | high | critical', 'normal')
  .option('--plan', 'Require plan approval before execution', false)
  .option('--max-beings <n>', 'Max beings the leader may spawn for this task')
  .action(async (description: string, opts: { priority: string; plan: boolean; maxBeings?: string }) => {
    const maxBeings = opts.maxBeings !== undefined ? Math.max(1, parseInt(opts.maxBeings, 10) || 1) : undefined;
    const task = await enqueueTask({
      title: description.slice(0, 80),
      description,
      priority: opts.priority as 'low' | 'normal' | 'high' | 'critical',
      requiresPlanApproval: opts.plan,
      maxBeings,
      createdBy: 'human',
    });
    await appendSignal('TASK_ADDED', { taskId: task.id, title: task.title });
    console.log(`\n✅ Task enqueued:`);
    console.log(`   ID:          ${task.id}`);
    console.log(`   Title:       ${task.title}`);
    console.log(`   Priority:    ${task.priority}`);
    if (maxBeings !== undefined) console.log(`   Max beings:  ${maxBeings}`);
    console.log(`\n   The Orchestrator will assign it on the next scheduler tick.\n`);
    process.exit(0);
  });

program
  .command('meetup')
  .description('Freeze beings for a human meetup (global or task-specific)')
  .option('--task <taskId>', 'Freeze only the runner for this task ID (prefix supported)')
  .action(async (opts: { task?: string }) => {
    if (opts.task) {
      await appendSignal('MEETUP_FREEZE', { taskId: opts.task });
      console.log(`\n❄️  Freeze signal sent for task ${opts.task.slice(0, 8)}.`);
      console.log(`   In the world terminal: /msg --task ${opts.task.slice(0, 8)} <message>`);
      console.log(`   Then: /done  to resume the task runner.\n`);
    } else {
      await triggerMeetupFreeze();
      console.log(`\n❄️  Global freeze signal sent.`);
      console.log(`   All runners will pause. Type messages in the world terminal.`);
      console.log(`   Type /done in the world terminal to resume all.\n`);
    }
    process.exit(0);
  });

program
  .command('status')
  .description('Show world status: day, tasks, active runners, pending signals')
  .action(async () => {
    const state = await readWorldState();
    const tasks = await getTaskSummary();
    const { readSignals, readRuntimeState } = await import('./memory/store.js');
    const signals = await readSignals();
    const runtime = await readRuntimeState();
    const pending = signals.filter((s) => !s.processed);
    const allTasks = await getAllTasks();
    const runningTasks = allTasks.filter((t) => t.status === 'in-progress');
    const mode = runtime.frozen
      ? '❄️  FROZEN (meetup)'
      : runtime.resting
        ? '⏸  RESTING'
        : '▶️  RUNNING';

    console.log(`\n🌍 Vibe Guild Status`);
    console.log(`   Mode:    ${mode}`);
    console.log(`   Day:     ${state.dayCount}`);
    console.log(`   Started: ${state.startedAt ?? 'not yet'}`);
    if (runtime.updatedAt) console.log(`   Updated: ${runtime.updatedAt}`);
    console.log(`\n📋 Tasks`);
    console.log(`   Pending:     ${tasks.pending}`);
    console.log(`   Assigned:    ${tasks.assigned ?? 0}`);
    console.log(`   In Progress: ${tasks.inProgress}`);
    console.log(`   Completed:   ${tasks.completed}`);
    console.log(`   Blocked:     ${tasks.blocked}`);
    if (runningTasks.length > 0) {
      console.log(`\n🏃 Active Runners`);
      for (const t of runningTasks) {
        console.log(`   • ${t.id.slice(0, 8)} — ${t.title.slice(0, 60)}`);
        console.log(`     leader: ${t.leaderId ?? '?'}  beings: ${(t.assignedTo ?? []).join(', ')}`);
        console.log(`     progress → world/tasks/${t.id}/progress.json`);
      }
    }
    console.log(`\n📡 Pending Signals: ${pending.length}`);
    for (const s of pending) console.log(`   • ${s.type} (${s.createdAt})`);
    console.log('');
    process.exit(0);
  });

program
  .command('progress <taskId>')
  .description('Show progress.json for a task (short ID prefix supported)')
  .action(async (taskId: string) => {
    const { readTaskProgress } = await import('./memory/store.js');
    const allTasks = await getAllTasks();
    const task = allTasks.find((t) => t.id === taskId || t.id.startsWith(taskId));
    if (!task) {
      console.log(`\n⚠️  Task not found: ${taskId}\n`);
      process.exit(1);
    }
    const progress = await readTaskProgress(task.id);
    if (!progress) {
      console.log(`\n📭 No progress file yet for task ${task.id.slice(0, 8)}: "${task.title}"\n`);
    } else {
      console.log(`\n📊 Progress — ${task.title}`);
      console.log(`   Leader:   ${progress.leaderId}`);
      console.log(`   Status:   ${progress.status}`);
      console.log(`   Complete: ${progress.percentComplete}%`);
      console.log(`   Summary:  ${progress.summary}`);
      console.log(`   Updated:  ${progress.lastUpdated}`);
      if (progress.checkpoints.length > 0) {
        console.log(`   Checkpoints:`);
        for (const cp of progress.checkpoints) {
          console.log(`     • [${cp.at}] ${cp.description}`);
        }
      }
    }
    console.log('');
    process.exit(0);
  });

program.parse(process.argv);
if (process.argv.length < 3) program.help();

