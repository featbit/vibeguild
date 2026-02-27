import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { program } from 'commander';
import {
  drainPendingSignals,
  markWorldStarted,
  incrementDay,
  writeDailyRecord,
  readWorldState,
  appendSignal,
  writeRuntimeState,
  readEscalations,
} from './memory/store.js';
import {
  enqueueTask,
  getPendingTasks,
  getTasksByStatus,
  getTaskSummary,
  getAllTasks,
  reviseTask,
  updateTaskStatus,
} from './tasks/queue.js';
import { createTaskRunner, type WorldTaskRunner } from './tasks/runner.js';
import { loadRuntimeConfig, worldPath } from './runtime/config.js';
import {
  triggerMeetupFreeze,
  triggerMeetupResume,
} from './scheduler/clock.js';
import { createWorldMcpServer } from './tools/report.js';
import { notifyDiscord, notifyDiscordRaw, notifyTask, createTaskThread, registerExistingThread, setOnThreadRegistered, initDiscordBot, flushDiscord, updateTaskThreadWithRepo, closeTaskThread, getTaskThreadMention, getTaskThreadUrl, getActiveThreadLinks, getTaskIdByChannelId } from './discord.js';
import type { OnMentionFn } from './discord.js';

// ─── World Engine ─────────────────────────────────────────────────────────────

const runWorldLoop = async (): Promise<void> => {

  // ── State ────────────────────────────────────────────────────────────────
  const activeRunners = new Map<string, WorldTaskRunner>();
  const globalHumanMessages: string[] = [];
  // Tasks frozen by a task-level meetup (not globally frozen)
  const frozenTaskIds: string[] = [];
  let frozen = false;       // true during global meetup
  let resting = false;      // true between SHIFT_REST_START and SHIFT_DAY_END
  let schedulerBusy = false;

  /**
   * When non-null, the user is in an alignment dialogue with this task.
   * All plain terminal input is routed directly to that task's inbox instead
   * of being treated as an Orchestrator message.
   */
  let aligningTaskId: string | null = null;

  const mcpServer = await createWorldMcpServer();

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
      console.log(`\n📍 [task:${short}] ${bar} ${pct}% — ${p.summary}`);
      if (latestMsg) console.log(`     ↳ ${latestMsg}`);
      notifyTask(p.taskId, `📍 [task:${short}] ${pct}% — ${p.summary}${latestMsg ? `\n   ↳ ${latestMsg}` : ''}`);

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
        console.log(`\n🤔 [task:${short}] Agent needs your input:`);
        console.log(`   "${question}"`);
        console.log(`   ► Type your reply (press Enter to send). Type /done to let the agent proceed independently.\n`);
        notifyTask(p.taskId, `🤔 [task:${short}] Agent needs input:\n   "${question}"`);
      } else if (p.status === 'waiting_for_human' && aligningTaskId === p.taskId) {
        // Already in alignment mode — agent wrote a new waiting_for_human (acknowledgment or follow-up)
        const question = p.question ?? p.summary;
        console.log(`\n💬 [task:${short}] ${question}`);
        console.log(`   ► Your reply:\n`);
        notifyTask(p.taskId, `💬 [task:${short}] ${question}`);
      }

      // Auto-exit alignment mode when agent resumes on its own
      if (aligningTaskId === p.taskId && p.status !== 'waiting_for_human') {
        aligningTaskId = null;
        console.log(`\n✅ [task:${short}] Alignment resolved. Resuming task.\n`);
        notifyTask(p.taskId, `✅ [task:${short}] Alignment resolved. Resuming task.`);
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
        // All checkpoints — show everything the agent actually did
        if (Array.isArray(p.checkpoints) && p.checkpoints.length > 0) {
          lines.push('**Steps completed:**');
          for (const cp of p.checkpoints) {
            const desc = (cp as Record<string, unknown>)['description'] as string | undefined;
            if (desc) lines.push(`• ${desc}`);
          }
        }
        if (p.sandboxRepoUrl) lines.push(`🔗 **Repo:** ${p.sandboxRepoUrl}`);
        // Try to read output/<taskId>/README.md for a richer results summary
        void (async () => {
          const cfg2 = loadRuntimeConfig();
          const outputReadme = join(cfg2.workspaceRoot, 'output', p.taskId, 'README.md');
          try {
            const readme = await readFile(outputReadme, 'utf8');
            // Prefer the ## Results section; fall back to first 800 chars
            const resultsMatch = readme.match(/## Results([\s\S]{0,1500})/);
            const snippet = resultsMatch ? resultsMatch[1].trim() : readme.slice(0, 800).trim();
            if (snippet) lines.push(`\n**Output summary:**\n${snippet}`);
          } catch { /* no README — fine */ }
          notifyTask(p.taskId, lines.join('\n'));
        })();
        return; // notifyTask called inside async block above
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

  const state = await readWorldState();
  const runtimeMode = process.env['RUNTIME_MODE'] ?? 'local';
  const modelId = process.env['ANTHROPIC_MODEL_ID'] ?? 'default';
  const dockerImage = process.env['SANDBOX_DOCKER_IMAGE'] ?? 'vibeguild-sandbox';
  console.log(`\n🌍 LP;HU world is alive. Day ${state.dayCount} starting.`);
  console.log(`   Runtime   : ${runtimeMode}${runtimeMode === 'docker' ? ` (image: ${dockerImage})` : ' (in-process SDK)'}`);
  console.log(`   Model     : ${modelId}`);
  console.log(`   World day : ${state.dayCount}  |  tasks: ${(await getAllTasks()).length}\n`);
  {
    const taskCount = (await getAllTasks()).length;
    notifyDiscord(
      `🌍 LP;HU world alive — Day ${state.dayCount}\n` +
      `   Runtime : ${runtimeMode}${runtimeMode === 'docker' ? ` (${dockerImage})` : ''}\n` +
      `   Model   : ${modelId} | tasks: ${taskCount}`,
    );
  }

  // ── Restore thread registry from disk (survives restarts) ─────────────────
  {
    const cfg = loadRuntimeConfig();
    const tasksBaseDir = join(worldPath(cfg), 'tasks');
    try {
      const entries = await readdir(tasksBaseDir, { withFileTypes: true });
      let restored = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const raw = await readFile(join(tasksBaseDir, entry.name, 'thread.json'), 'utf8');
          const data = JSON.parse(raw) as { channelId?: string };
          if (data.channelId) { registerExistingThread(entry.name, data.channelId); restored++; }
        } catch { /* no thread.json for this task — fine */ }
      }
      if (restored > 0) console.log(`   Thread registry restored: ${restored} task(s)`);
    } catch { /* tasks dir may not exist yet */ }
  }

  // Persist new thread registrations to disk so they survive restarts.
  setOnThreadRegistered((taskId, channelId) => {
    const cfg2 = loadRuntimeConfig();
    const taskDir = join(worldPath(cfg2), 'tasks', taskId);
    void mkdir(taskDir, { recursive: true })
      .then(() => writeFile(join(taskDir, 'thread.json'), JSON.stringify({ channelId }, null, 2), 'utf8'))
      .catch(() => undefined);
  });

  // ── Recover in-progress tasks from a previous run ────────────────────────
  {
    const savedTasks = await getAllTasks();
    const recovering = savedTasks.filter((t) => t.status === 'in-progress');
    for (const task of recovering) {
      console.log(`\n♻️  [World] Recovering task ${task.id.slice(0, 8)}: "${task.title}"`);
      notifyDiscord(`♻️  [World] Recovering task ${task.id.slice(0, 8)}\n   "${task.title.slice(0, 72)}"`);
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
          `> age: ${ageStr}  |  ${progress.percentComplete ?? 0}% done`,
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

    // /revise <id> <feedback> — re-run a completed/failed task with creator feedback
    if (input.startsWith('/revise ')) {
      const rest = input.slice(8).trim();
      const spaceIdx = rest.search(/\s/);
      const rawId = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      const feedback = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();

      if (!feedback) {
        console.log(`\n⚠️  Usage: /revise <id> <feedback>\n`);
        return;
      }

      void (async () => {
        const allTasks = await getAllTasks();
        const task = allTasks.find((t) => t.id === rawId || t.id.startsWith(rawId));
        if (!task) {
          console.log(`\n⚠️  Task not found: ${rawId}\n`);
          return;
        }
        if (task.status !== 'completed' && task.status !== 'failed') {
          console.log(`\n⚠️  Task ${task.id.slice(0, 8)} is "${task.status}" — can only revise completed or failed tasks.\n`);
          return;
        }
        if (activeRunners.has(task.id)) {
          console.log(`\n⚠️  Task ${task.id.slice(0, 8)} already has an active runner.\n`);
          return;
        }

        const revised = await reviseTask(task.id, feedback);
        if (!revised) return;

        // Write the feedback to inbox.json — entrypoint reads it at startup
        // as INITIAL INSTRUCTIONS FROM OPERATOR (see entrypoint.mjs line ~841)
        const cfg = loadRuntimeConfig();
        const taskDir = join(worldPath(cfg), 'tasks', revised.id);
        await mkdir(taskDir, { recursive: true });
        await writeFile(
          join(taskDir, 'inbox.json'),
          JSON.stringify({
            messages: [
              `[REVISION REQUEST] The creator has reviewed your previous output and is not satisfied.\n` +
              `This is revision #${revised.revisionCount}.\n\n` +
              `Creator's feedback:\n${feedback}\n\n` +
              `Please review the existing repo and outputs, then address the feedback. ` +
              `Continue from where you left off — do not start from scratch unless the feedback explicitly says so.`,
            ],
          }, null, 2),
          'utf-8',
        );

        const revNum = revised.revisionCount ?? 1;
        console.log(`\n✏️  Revision #${revNum} started for task ${revised.id.slice(0, 8)}: "${revised.title.slice(0, 72)}"`);
        console.log(`   Feedback: "${feedback.slice(0, 120)}"\n`);
        notifyDiscord(
          `✏️  **Revision #${revNum}** — \`${revised.id.slice(0, 8)}\`\n` +
          `   "${revised.title.slice(0, 72)}"\n` +
          `   feedback: "${feedback.slice(0, 200)}"`,
        );
        void createTaskThread(revised);
        const runner = createTaskRunner(revised, runnerOpts);
        activeRunners.set(revised.id, runner);
        void runner.start(revised);
      })();
      return;
    }
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

  // ── Discord bot command drainer ───────────────────────────────────────────
  // After each SDK call, drain any world commands Claude queued via scripts/vg-cmd.mjs.
  // Entries may be plain strings OR {cmd, channelId} objects.
  // When channelId is present on a /task command, the existing forum post is
  // registered as the task thread (no new post created).
  const drainDiscordPendingCmds = async (): Promise<void> => {
    const cfg = loadRuntimeConfig();
    const cmdFile = join(worldPath(cfg), 'discord-pending-cmds.json');
    try {
      const raw = await readFile(cmdFile, 'utf8');
      const entries = JSON.parse(raw) as Array<string | { cmd: string; channelId?: string }>;
      await writeFile(cmdFile, '[]', 'utf8');
      for (const entry of entries) {
        const cmd = typeof entry === 'string' ? entry : entry.cmd;
        const sourceChannelId = typeof entry === 'object' ? entry.channelId : undefined;
        if (!cmd.startsWith('/')) continue;
        console.log(`\n📨 [Discord Bot cmd] ${cmd}`);

        // /task — create task and immediately auto-assign
        if (cmd.startsWith('/task ')) {
          const desc = cmd.slice(6).trim();
          void (async () => {
            const task = await enqueueTask({ title: desc, description: desc, createdBy: 'human' });
            console.log(`\n📋 Task added: ${task.id}\n`);
            if (sourceChannelId) registerExistingThread(task.id, sourceChannelId);

            await updateTaskStatus(task.id, 'assigned');
            const assigned = (await getAllTasks()).find((t) => t.id === task.id)!;
            notifyDiscord(`📋 Task added: ${task.id.slice(0, 8)}\n   "${desc.slice(0, 120)}" (auto-assigned)`);
            void appendSignal('TASK_ADDED', { taskId: task.id });
            // Start runner directly
            const runner = createTaskRunner(assigned, runnerOpts);
            activeRunners.set(task.id, runner);
            void runner.start(assigned);
            void createTaskThread(assigned).then(() => {
              const threadUrl = getTaskThreadUrl(task.id);
              if (threadUrl) notifyDiscordRaw(`🧵 Thread ready for \`${task.id.slice(0, 8)}\`: [Open →](${threadUrl})`);
            });
          })();
          continue;
        }

        processLine(cmd);
      }
    } catch { /* file may not exist — fine */ }
  };

  // ── Claude Code SDK @mention handler ─────────────────────────────────────
  const handleMention: OnMentionFn = async (userMessage, _username, _userId, channelId, sessionId, reply, threadHistory): Promise<string | null> => {
    const cfg = loadRuntimeConfig();
    const workspaceRoot = cfg.workspaceRoot;

    // Build fresh world context on every call
    const allTasks = await getAllTasks();
    const now = Date.now();
    const taskLines = allTasks.length === 0
      ? '  (no tasks yet)'
      : allTasks.map((t) => {
          const ageMs = now - new Date(t.createdAt ?? now).getTime();
          const ageH  = Math.round(ageMs / 36e5);
          const age   = ageH < 1 ? 'just now' : ageH < 24 ? `${ageH}h ago` : `${Math.round(ageH / 24)}d ago`;
          const short = t.id.slice(0, 8);
          const leader   = (t as Record<string, unknown>)['leader'] as string | undefined;
          const prog     = (t as Record<string, unknown>)['progress'] as string | undefined;
          const revNote  = (t as Record<string, unknown>)['revisionNote'] as string | undefined;
          const revCount = (t as Record<string, unknown>)['revisionCount'] as number | undefined;
          return `  ${short} [${t.status}]${leader ? ` [${leader}]` : ''} "${(t.title ?? '').slice(0, 70)}" (${age})${prog ? ` — ${prog.slice(0, 60)}` : ''}${revCount ? ` (rev#${revCount}${revNote ? ` "${revNote.slice(0, 30)}"` : ''})` : ''}`;
        }).join('\n');

    const threadLines = getActiveThreadLinks()
      .map((th) => `  ${th.short} → ${th.url ?? th.mention} "${th.title.slice(0, 60)}"`)
      .join('\n') || '  (none)';

    const threadTaskId = getTaskIdByChannelId(channelId);
    const threadTask   = threadTaskId ? allTasks.find((t) => t.id === threadTaskId) : undefined;

    const worldContext = [
      `## World State (refreshed ${new Date().toISOString()})`,
      `Tasks (${allTasks.length} total):`,
      taskLines,
      '',
      'Active Discord threads:',
      threadLines,
      ...(threadTask ? [
        '',
        '## Thread Context',
        `This message came from the Discord thread for task ${threadTask.id.slice(0, 8)} [${threadTask.status}] "${(threadTask.title ?? '').slice(0, 70)}".`,
        'Treat this as the primary task unless the operator specifies otherwise.',
      ] : []),
    ].join('\n');

    // Load Discord bot MCP config from .claude/mcp-servers.json (bot-specific).
    // Task runner sandbox uses world/shared/mcp-servers.json separately.
    let mcpServers: Record<string, unknown> = {};
    try {
      const raw = await readFile(join(workspaceRoot, '.claude/mcp-servers.json'), 'utf8');
      mcpServers = JSON.parse(raw) as Record<string, unknown>;
    } catch { /* not configured — fine */ }

    // First call (no session): include role + behaviour instructions.
    // On resume: just inject fresh world state so Claude has the current task list.
    const prompt = sessionId
      ? [worldContext, '', `Operator: ${userMessage}`].join('\n')
      : [
          'You are the Vibe Guild operator assistant, embedded in Discord.',
          'Vibe Guild is an autonomous AI world where AI agents (beings) run long-running tasks in Docker containers.',
          'The operator uses you to manage tasks, inspect progress, read output, and communicate with running agents.',
          '',
          '## How to read world state',
          '- `node scripts/vg.mjs overview` — world dashboard',
          '- `node scripts/vg.mjs tasks` — all tasks',
          '- `node scripts/vg.mjs progress <8-char-id>` — task progress detail',
          '- Or read files directly: world/tasks/<uuid>/progress.json, output/<uuid>/',
          '',
          '## How to execute world commands',
          'Queue a command via Bash (executes after you reply):',
          `  \`node scripts/vg-cmd.mjs cmd "/task <full description>" ${channelId}\``,
          '  `node scripts/vg-cmd.mjs cmd "/revise <8-char-id> <feedback>"`',
          '  `node scripts/vg-cmd.mjs cmd "/pause --task <8-char-id> [msg]"`',
          '  `node scripts/vg-cmd.mjs cmd "/msg --task <8-char-id> <text>"`',
          '  `node scripts/vg-cmd.mjs cmd "/done"`',
          '  (The channel ID after /task tells the world to reuse this Discord post as the task thread.)',
          '',
          '## CRITICAL: /task vs /revise — choosing the right command',
          '- `/task` = brand new work, **creates a new GitHub repo** and new Docker container.',
          '- `/revise <id> <feedback>` = continue/fix existing work, **reuses the same GitHub repo** already created for that task.',
          '- Use your judgment to decide which one fits the operator\'s intent. When in doubt, ask the operator before proceeding.',
          '- If this message came from a task thread, the task to revise is most likely the one this thread belongs to.',
          '',
          '## Skills',
          'Agent Skills in .claude/skills/ are auto-discovered. Use them when relevant.',
          '',
          '## Behaviour rules',
          '- Always respond in the same language as the operator (Chinese if they write Chinese, English otherwise). Be concise.',
          '- For informational requests (status, progress, output): use tools immediately.',
          '- For creating NEW tasks or revising existing ones: confirm with the operator FIRST (say what you will do, which command you will use, and ask "shall I proceed?"). Only queue the command when they confirm.',
          '- For pause/msg/done: queue immediately, no confirmation needed.',
          ...(threadTask ? [
            '- **You are inside a task thread. Any code work (fix, test, build, run, or reading a GitHub repo) must go through /revise in Docker — do NOT use Bash to write/edit files, clone repos, run npm/git, or fetch GitHub content directly. Reading local world state files via Bash is fine.**',
          ] : []),
          '',
          worldContext,
          // Include thread history when available (especially important after a restart when
          // the SDK session is gone but the Discord thread already has conversation context).
          ...(threadHistory ? [
            '',
            '## Recent conversation history in this Discord thread (read-only context)',
            '(These are the messages that appeared above your @mention in this thread.)',
            threadHistory,
          ] : []),
          '',
          `Operator: ${userMessage}`,
        ].join('\n');

    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    // Note: do NOT forward ANTHROPIC_MODEL_ID to the SDK — it is the BigModel
    // proxy model name (GLM-5) and is not understood by the Claude Code SDK.
    // The SDK uses the claude CLI which manages its own model selection.
    const sdkOptions: Record<string, unknown> = {
      allowedTools: ['Read', 'Write', 'Bash', 'WebSearch', 'WebFetch'],
      settingSources: ['project'],
      permissionMode: 'bypassPermissions',
      maxTurns: 10,
      ...(sessionId ? { resume: sessionId } : {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    };

    let newSessionId: string | null = sessionId;
    let finalReply = '';

    console.log(`[Discord/SDK] query() start – channel=${channelId} resume=${!!sessionId}`);
    try {
      for await (const msg of query({ prompt, options: sdkOptions as Parameters<typeof query>[0]['options'] })) {
        const m = msg as Record<string, unknown>;
        console.log(`[Discord/SDK] msg type=${String(m['type'])} subtype=${String(m['subtype'] ?? '')}`);
        if (m['type'] === 'system' && m['subtype'] === 'init' && m['session_id']) {
          newSessionId = m['session_id'] as string;
          console.log(`[Discord/SDK] session_id=${newSessionId}`);
        }
        if (m['type'] === 'assistant') {
          const msgContent = (m['message'] as Record<string, unknown>)?.['content'];
          const blocks = Array.isArray(msgContent) ? msgContent : [];
          for (const block of blocks as Array<Record<string, unknown>>) {
            if (block['type'] === 'text' && typeof block['text'] === 'string') {
              finalReply = block['text'];
            }
          }
        }
        if (m['type'] === 'result') {
          // SDKResultSuccess.result contains the final assistant text
          if (typeof m['result'] === 'string' && m['result']) {
            finalReply = m['result'];
          }
          console.log(`[Discord/SDK] result subtype=${String(m['subtype'])} reply_length=${finalReply.length}`);
        }
      }
      console.log(`[Discord/SDK] query() done – reply length=${finalReply.length}`);
    } catch (err) {
      console.error(`[Discord/SDK] query() error:`, err);
      await reply(`❌ Agent error: ${err instanceof Error ? err.message : String(err)}`);
      return newSessionId;
    }

    // Drain any world commands Claude queued via scripts/vg-cmd.mjs
    await drainDiscordPendingCmds();

    if (finalReply) {
      await reply(finalReply);
    }

    return newSessionId;
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
      const restMsg =
        `REST PERIOD — Day ${dayCount}. ` +
        `At your next convenient stopping point (between tool calls, not mid-operation): ` +
        `write a progress checkpoint to world/tasks/${'{taskId}'}/progress.json. ` +
        `Then CONTINUE your work — do NOT stop or wait.`;      let injected = 0;
      for (const [taskId, runner] of activeRunners) {
        const msg = restMsg.replace('{taskId}', taskId);
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
      const escalations = await readEscalations();
      const todayEscalations = escalations.filter((e) => e.createdAt.startsWith(today));
      const inProgress = await getTasksByStatus('in-progress');
      await writeDailyRecord({
        date: today,
        dayCount: worldState.dayCount,
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

    // ── Start runners for newly assigned tasks ────────────────────────────
    const assignedTasks = await getTasksByStatus('assigned');
    for (const task of assignedTasks) {
      if (!activeRunners.has(task.id)) {
        const cfg2 = loadRuntimeConfig();
        const ageMs = Date.now() - new Date(task.createdAt).getTime();
        const ageSec = Math.floor(ageMs / 1000);
        const ageStr = ageSec < 60 ? `${ageSec}s` : `${Math.floor(ageSec / 60)}m${ageSec % 60}s`;
        console.log(`\n🚀 [World] Starting runner — task ${task.id.slice(0, 8)}`);
        console.log(`   Title    : ${task.title.slice(0, 72)}`);
        console.log(`   Priority : ${task.priority}  |  age: ${ageStr}`);
        console.log(`   Mode     : ${cfg2.mode}${cfg2.mode === 'docker' ? ` (image: ${cfg2.dockerImage}, exec: ${cfg2.executionMode})` : ' (local SDK)'}`);
        const runner = createTaskRunner(task, runnerOpts);
        activeRunners.set(task.id, runner);
        void runner.start(task);
        // Start thread creation in background; once resolved, post notification with clickable link.
        void createTaskThread(task).then(() => {
          const threadUrl = getTaskThreadUrl(task.id);
          notifyDiscordRaw(
            `🚀 **Task started** \`${task.id.slice(0, 8)}\`\n` +
            `> "${task.title.slice(0, 72)}"\n` +
            `> priority: ${task.priority}` +
            (threadUrl ? `\n> 🧵 [Open thread →](${threadUrl})` : ''),
          );
        });
      }
    }

    // ── Auto-assign pending tasks ─────────────────────────────────────────
    const pendingTasks = await getPendingTasks();
    for (const task of pendingTasks) {
      await updateTaskStatus(task.id, 'assigned');
      const ageMs = Date.now() - new Date(task.createdAt).getTime();
      const ageStr = ageMs < 60_000 ? `${Math.floor(ageMs / 1000)}s` : `${Math.floor(ageMs / 60_000)}m`;
      console.log(`\n📋 Task auto-assigned: ${task.id.slice(0, 8)}  [${task.priority}]  age:${ageStr}  "${task.title.slice(0, 72)}"`);
      notifyDiscord(`📋 Task assigned: ${task.id.slice(0, 8)}\n   "${task.title.slice(0, 120)}"`);
      void appendSignal('TASK_ADDED', { taskId: task.id });
    }

    // Route queued human messages to Discord
    if (globalHumanMessages.length > 0) {
      const msgs = globalHumanMessages.splice(0);
      for (const msg of msgs) {
        notifyDiscord(`💬 [Operator] ${msg}`);
      }
    }
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
  .action(async (description: string, opts: { priority: string; plan: boolean }) => {
    const task = await enqueueTask({
      title: description.slice(0, 80),
      description,
      priority: opts.priority as 'low' | 'normal' | 'high' | 'critical',
      requiresPlanApproval: opts.plan,
      createdBy: 'human',
    });
    await appendSignal('TASK_ADDED', { taskId: task.id, title: task.title });
    console.log(`\n✅ Task enqueued:`);
    console.log(`   ID:          ${task.id}`);
    console.log(`   Title:       ${task.title}`);
    console.log(`   Priority:    ${task.priority}`);
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

