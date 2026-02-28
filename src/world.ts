import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirnameWorld = dirname(fileURLToPath(import.meta.url));
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
import { startCronScheduler, reloadCronScheduler, fireJobNow } from './cron/scheduler.js';
import {
  listCronJobs,
  addCronJob,
  updateCronJob,
  removeCronJob,
  setCronJobDiscordThread,
} from './cron/store.js';
import type { CronJobCreate } from './cron/types.js';
import { createWorldMcpServer } from './tools/report.js';
import { notifyDiscord, notifyDiscordRaw, notifyTask, createTaskThread, registerExistingThread, setOnThreadRegistered, initDiscordBot, flushDiscord, updateTaskThreadWithRepo, closeTaskThread, getTaskThreadMention, getTaskThreadUrl, getActiveThreadLinks, getTaskIdByChannelId, deleteDiscordChannel, listTasksChannelPosts, updateCronJobThreadTitle, getCronJobIdByThreadId } from './discord.js';
import type { OnMentionFn } from './discord.js';

// ─── World Engine ─────────────────────────────────────────────────────────────

const runWorldLoop = async (): Promise<void> => {

  // ── State ────────────────────────────────────────────────────────────────
  const activeRunners = new Map<string, WorldTaskRunner>();
  const globalHumanMessages: string[] = [];
  // Tasks frozen by a task-level meetup (not globally frozen)
  const frozenTaskIds: string[] = [];
  /** cron-triggered task IDs — used to skip closeTaskThread (we don't own that post title) */
  const cronTaskIds = new Set<string>();
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
        // Post to the task/cron thread
        notifyTask(p.taskId, `🤔 [task:${short}] Agent needs input:\n   "${question}"`);
        // Also ping control-plane so operator sees it even if they're not watching the task thread
        {
          const threadUrl = getTaskThreadUrl(p.taskId);
          const loc = threadUrl ? ` → [open thread](${threadUrl})` : '';
          notifyDiscordRaw(`🤔 **Agent needs your input** \`${short}\`${loc}\n> "${question.slice(0, 300)}"\n> Reply in terminal or via \`/pause --task ${short}\``);
        }
      } else if (p.status === 'waiting_for_human' && aligningTaskId === p.taskId) {
        // Already in alignment mode — agent wrote a new waiting_for_human (acknowledgment or follow-up)
        const question = p.question ?? p.summary;
        console.log(`\n💬 [task:${short}] ${question}`);
        console.log(`   ► Your reply:\n`);
        notifyTask(p.taskId, `💬 [task:${short}] ${question}`);
        {
          const threadUrl = getTaskThreadUrl(p.taskId);
          const loc = threadUrl ? ` → [open thread](${threadUrl})` : '';
          notifyDiscordRaw(`💬 **[task:${short}]**${loc}\n> ${question.slice(0, 300)}`);
        }
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
        // Update the thread title ✅/❌ — skip for cron tasks (we don't own that post's title)
        if (!cronTaskIds.has(p.taskId)) void closeTaskThread(p.taskId, p.status);
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
          const outputDir = join(cfg2.workspaceRoot, 'output', p.taskId);
          // First: check for output/messages/*.md — each file = one Discord message (sorted by name)
          const messagesDir = join(outputDir, 'messages');
          try {
            const { readdir } = await import('fs/promises');
            const files = (await readdir(messagesDir)).filter((f) => f.endsWith('.md')).sort();
            if (files.length > 0) {
              notifyTask(p.taskId, lines.join('\n'));
              for (const f of files) {
                const content = (await readFile(join(messagesDir, f), 'utf8')).trim();
                if (content) notifyTask(p.taskId, content, true);  // separate=true → own Discord message
              }
              return;
            }
          } catch { /* no messages dir — fall through */ }
          // Fallback: read README.md ## Results section
          try {
            const readme = await readFile(join(outputDir, 'README.md'), 'utf8');
            const resultsMatch = readme.match(/## Results([\s\S]{0,3000})/);
            const snippet = resultsMatch ? resultsMatch[1].trim() : readme.slice(0, 800).trim();
            if (snippet) lines.push(`\n**Output:**\n${snippet}`);
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
      if (task.discordThreadId) { registerExistingThread(task.id, task.discordThreadId); cronTaskIds.add(task.id); }
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

    // /cron — manage scheduled cron jobs
    if (input.startsWith('/cron')) {
      void (async () => {
        const args = input.slice(5).trim();

        // /cron list
        if (!args || args === 'list') {
          const jobs = await listCronJobs();
          if (jobs.length === 0) {
            notifyDiscord('⏰ No cron jobs registered.');
            return;
          }
          const lines = jobs.map((j) => {
            const sched =
              j.schedule.kind === 'cron'
                ? `cron:${j.schedule.expr}${j.schedule.tz ? ` (${j.schedule.tz})` : ''}`
                : j.schedule.kind === 'every'
                  ? `every:${j.schedule.everyMs}ms`
                  : `at:${j.schedule.at}`;
            const status = j.enabled ? '✅' : '⏸';
            const last = j.state.lastRunAtMs
              ? ` | last:${new Date(j.state.lastRunAtMs).toISOString().slice(11, 19)}Z`
              : '';
            const next = j.state.nextRunAtMs
              ? ` | next:${new Date(j.state.nextRunAtMs).toISOString().slice(11, 19)}Z`
              : '';
            return `${status} \`${j.id.slice(0, 8)}\`  **${j.name}**  \`${sched}\`${last}${next}`;
          });
          notifyDiscordRaw(`**⏰ Cron Jobs (${jobs.length})**\n${lines.join('\n')}`);
          return;
        }

        // /cron add <json>
        if (args.startsWith('add ')) {
          const rawJson = args.slice(4).trim();
          // Normalize curly/smart quotes that LLMs sometimes emit → straight quotes
          const jsonStr = rawJson
            .replace(/[\u201c\u201d\u201e\u201f\u2033\u2036]/g, '"')
            .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035]/g, "'");
          let input: CronJobCreate;
          try {
            input = JSON.parse(jsonStr) as CronJobCreate;
          } catch {
            notifyDiscord(`❌ /cron add: invalid JSON — ${jsonStr.slice(0, 100)}`);
            return;
          }
          try {
            const job = await addCronJob(input);
            await reloadCronScheduler();
            notifyDiscord(
              `⏰ Cron job added: \`${job.id.slice(0, 8)}\` **${job.name}**`,
            );
          } catch (err) {
            notifyDiscord(`❌ /cron add failed: ${String(err).slice(0, 200)}`);
          }
          return;
        }

        // /cron remove <id>
        if (args.startsWith('remove ')) {
          const prefix = args.slice(7).trim();
          const jobs = await listCronJobs();
          const job = jobs.find((j) => j.id === prefix || j.id.startsWith(prefix));
          if (!job) { notifyDiscord(`⚠️ No cron job matching "${prefix}"`); return; }
          await removeCronJob(job.id);
          await reloadCronScheduler();
          notifyDiscord(`🗑️ Cron job removed: \`${job.id.slice(0, 8)}\` **${job.name}**`);
          return;
        }

        // /cron enable <id>
        if (args.startsWith('enable ')) {
          const prefix = args.slice(7).trim();
          const jobs = await listCronJobs();
          const job = jobs.find((j) => j.id === prefix || j.id.startsWith(prefix));
          if (!job) { notifyDiscord(`⚠️ No cron job matching "${prefix}"`); return; }
          await updateCronJob(job.id, { enabled: true });
          await reloadCronScheduler();
          void updateCronJobThreadTitle(job.id, true);
          notifyDiscord(`✅ Cron job enabled: \`${job.id.slice(0, 8)}\` **${job.name}**`);
          return;
        }

        // /cron disable <id>
        if (args.startsWith('disable ')) {
          const prefix = args.slice(8).trim();
          const jobs = await listCronJobs();
          const job = jobs.find((j) => j.id === prefix || j.id.startsWith(prefix));
          if (!job) { notifyDiscord(`⚠️ No cron job matching "${prefix}"`); return; }
          await updateCronJob(job.id, { enabled: false });
          await reloadCronScheduler();
          void updateCronJobThreadTitle(job.id, false);
          notifyDiscord(`⏸ Cron job disabled: \`${job.id.slice(0, 8)}\` **${job.name}**`);
          return;
        }

        // /cron run <id>  — fire immediately regardless of schedule
        if (args.startsWith('run ')) {
          const prefix = args.slice(4).trim();
          const jobs = await listCronJobs();
          const job = jobs.find((j) => j.id === prefix || j.id.startsWith(prefix));
          if (!job) { notifyDiscord(`⚠️ No cron job matching "${prefix}"`); return; }
          const taskId = await fireJobNow(job.id);
          notifyDiscord(
            taskId
              ? `⏰ Cron job fired manually: \`${job.id.slice(0, 8)}\` **${job.name}** → task \`${taskId.slice(0, 8)}\``
              : `⏰ Cron job fired manually: \`${job.id.slice(0, 8)}\` **${job.name}** (direct action)`,
          );
          return;
        }

        // Help
        notifyDiscordRaw(
          '**⏰ /cron usage:**\n' +
          '• `/cron list` — list all jobs\n' +
          '• `/cron add <json>` — add a job (see JSON schema below)\n' +
          '• `/cron remove <id>` — delete a job\n' +
          '• `/cron enable <id>` / `/cron disable <id>` — toggle\n' +
          '• `/cron run <id>` — fire immediately\n' +
          '\n**local runtime (inline, no container):**\n' +
          '```json\n' +
          '{\n' +
          '  "name": "Hello World",\n' +
          '  "enabled": true,\n' +
          '  "runtime": "local",\n' +
          '  "schedule": { "kind": "every", "everyMs": 10000 },\n' +
          '  "payload": { "description": "Posts hello world and current timestamp" }\n' +
          '}\n```' +
          '\n\n**docker runtime (spawns AI Task):**\n' +
          '```json\n' +
          '{\n' +
          '  "name": "Weekly review",\n' +
          '  "enabled": true,\n' +
          '  "runtime": "docker",\n' +
          '  "schedule": { "kind": "cron", "expr": "0 9 * * 1", "tz": "Asia/Shanghai" },\n' +
          '  "payload": { "title": "Weekly review", "description": "Review progress", "priority": "normal" }\n' +
          '}\n```',
        );
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
  // When channelId is present on a /cron add command, the new job is linked to
  // the existing forum post instead of creating a new one.
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

        // /cron add — create cron job; link to sourceChannelId if present (avoids new forum post)
        if (cmd.startsWith('/cron add ')) {
          const rawJson = cmd.slice('/cron add '.length).trim();
          // Normalize curly/smart quotes that LLMs sometimes emit → straight quotes
          const jsonStr = rawJson
            .replace(/[\u201c\u201d\u201e\u201f\u2033\u2036]/g, '"')
            .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035]/g, "'");
          // Only link to sourceChannelId if it's a cron-jobs thread, NOT a tasks thread
          const linkedThreadId = sourceChannelId && !getTaskIdByChannelId(sourceChannelId)
            ? sourceChannelId
            : undefined;
          void (async () => {
            let input: CronJobCreate;
            try {
              input = JSON.parse(jsonStr) as CronJobCreate;
            } catch {
              notifyDiscord(`❌ /cron add: invalid JSON — ${jsonStr.slice(0, 100)}`);
              return;
            }
            try {
              const job = await addCronJob(input);
              if (linkedThreadId) {
                await setCronJobDiscordThread(job.id, linkedThreadId);
                console.log(`\n🔗 [Cron] Linked job ${job.id.slice(0, 8)} to existing thread ${linkedThreadId}\n`);
              }
              await reloadCronScheduler();
              notifyDiscord(`⏰ Cron job added: \`${job.id.slice(0, 8)}\` **${job.name}**`);
            } catch (err) {
              notifyDiscord(`❌ /cron add failed: ${String(err).slice(0, 200)}`);
            }
          })();
          continue;
        }

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

        // /del-thread <channelId> — delete a Discord thread/post by channel ID
        if (cmd.startsWith('/del-thread ')) {
          const targetId = cmd.slice(12).trim();
          if (targetId) {
            void (async () => {
              const result = await deleteDiscordChannel(targetId);
              if (result.ok) {
                notifyDiscord(`🗑️ Thread deleted: ${targetId}`);
              } else {
                notifyDiscord(`❌ Failed to delete thread ${targetId}: ${result.error ?? 'unknown error'}`);
              }
            })();
          }
          continue;
        }

        // /list-threads — list all active posts in the tasks channel
        if (cmd === '/list-threads') {
          void (async () => {
            const posts = await listTasksChannelPosts();
            if (posts.length === 0) {
              notifyDiscord('📋 No active threads found in the tasks channel.');
            } else {
              const lines = posts.map((p) => `  ${p.id}  ${p.name.slice(0, 70)}`);
              notifyDiscord(`📋 Active threads in #tasks (${posts.length}):\n${lines.join('\n')}`);
            }
          })();
          continue;
        }

        processLine(cmd);
      }
    } catch { /* file may not exist — fine */ }
  };

  // ── Thread history compressor ──────────────────────────────────────────────
  // When a Discord thread has many messages, passing the full history to the SDK
  // burns turns on replay and risks hitting maxTurns before doing real work.
  // Strategy: keep the RECENT_KEEP most recent lines verbatim; summarise older
  // lines into one compact block (speaker → key action/decision, one line each).
  const compressThreadHistory = (history: string, recentKeep = 12): string => {
    const lines = history.split('\n').filter((l) => l.trim());
    if (lines.length <= recentKeep) return history;

    const older  = lines.slice(0, lines.length - recentKeep);
    const recent = lines.slice(lines.length - recentKeep);

    // Build a compact summary: deduplicate speaker+verb patterns
    const summaryLines: string[] = [];
    for (const line of older) {
      const colon = line.indexOf(':');
      if (colon === -1) { summaryLines.push(`  • ${line.slice(0, 100)}`); continue; }
      const who  = line.slice(0, colon).trim();
      const text = line.slice(colon + 1).trim().slice(0, 120);
      summaryLines.push(`  • [${who}] ${text}`);
    }

    return [
      `[Earlier conversation — ${older.length} messages compressed]`,
      ...summaryLines,
      '',
      `[Recent ${recentKeep} messages — verbatim]`,
      ...recent,
    ].join('\n');
  };

  // ── Claude Code SDK @mention handler ─────────────────────────────────────
  const handleMention: OnMentionFn = async (userMessage, _username, _userId, channelId, sessionId, reply, threadHistory): Promise<string | null> => {
    const cfg = loadRuntimeConfig();
    const workspaceRoot = cfg.workspaceRoot;

    // Build fresh world context on every call
    const allTasks = await getAllTasks();
    const allCronJobs = await listCronJobs();
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

    // Detect if this message came from a cron job's forum post
    const cronThreadJobId = getCronJobIdByThreadId(channelId);
    const cronThreadJob   = cronThreadJobId ? allCronJobs.find((j) => j.id === cronThreadJobId) : undefined;
    const isCronThread    = cronThreadJobId !== null;

    // ── Channel type detection ────────────────────────────────────────────
    // control-plane : world management channel — existing behaviour
    // task thread   : forum post for a task   — existing behaviour
    // cron thread   : forum post for a cron   — existing behaviour
    // text channel  : any other channel       → isolated workspace per channel
    const CONTROL_PLANE_CHANNEL = process.env['DISCORD_CONTROL_CHANNEL_ID'] ?? '';
    const isControlPlane = CONTROL_PLANE_CHANNEL !== '' && channelId === CONTROL_PLANE_CHANNEL;
    const isTextChannel  = !isControlPlane && !threadTaskId && cronThreadJobId === null;
    const textChannelDir = join(workspaceRoot, 'world', 'text-channels', channelId);

    if (isTextChannel) {
      await mkdir(textChannelDir, { recursive: true });
    }
    const cronScriptPath  = cronThreadJob?.runtime === 'local'
      ? join(__dirnameWorld, '..', 'world', 'crons', cronThreadJob.id, 'run.mjs')
      : null;
    const cronScriptExists = cronScriptPath ? existsSync(cronScriptPath) : false;

    // Build a human-readable schedule string for the cron thread context
    const formatCronSched = (j: typeof cronThreadJob): string => {
      if (!j) return '?';
      const s = j.schedule;
      if (s.kind === 'cron')  return `cron  ${s.expr}${s.tz ? ` (${s.tz})` : ''}`;
      if (s.kind === 'every') return `every ${s.everyMs}ms (${Math.round(s.everyMs / 1000)}s)`;
      return `at    ${s.at}`;
    };

    const cronLines = allCronJobs.length === 0
      ? '  (none)'
      : allCronJobs.map((j) => {
          const sched =
            j.schedule.kind === 'cron'
              ? `cron:${j.schedule.expr}${j.schedule.tz ? ` (${j.schedule.tz})` : ''}`
              : j.schedule.kind === 'every'
                ? `every:${j.schedule.everyMs}ms`
                : `at:${j.schedule.at}`;
          const last = j.state.lastRunAtMs ? new Date(j.state.lastRunAtMs).toISOString().slice(11, 19) + 'Z' : 'never';
          const next = j.state.nextRunAtMs ? new Date(j.state.nextRunAtMs).toISOString().slice(11, 19) + 'Z' : '—';
          return `  ${j.id.slice(0, 8)} [${j.enabled ? 'enabled' : 'disabled'}] "${j.name}" ${sched} | last:${last} | next:${next} | runs:${j.state.runCount ?? 0}`;
        }).join('\n');

    const worldContext = [
      `## World State (refreshed ${new Date().toISOString()})`,
      `Tasks (${allTasks.length} total):`,
      taskLines,
      '',
      `Cron Jobs (${allCronJobs.length} total):`,
      cronLines,
      '',
      'Active Discord threads:',
      threadLines,
      ...(threadTask ? [
        '',
        '## Thread Context',
        `This message came from the Discord thread for task ${threadTask.id.slice(0, 8)} [${threadTask.status}] "${(threadTask.title ?? '').slice(0, 70)}".`,
        'Treat this as the primary task unless the operator specifies otherwise.',
      ] : []),
      ...(isCronThread ? [
        '',
        '## Cron Thread Context',
        cronThreadJob
          ? [
              `This message came from the Discord forum post for cron job \`${cronThreadJob.id.slice(0, 8)}\` "${cronThreadJob.name}".`,
              '',
              'Current config:',
              `  ID       : ${cronThreadJob.id}`,
              `  Name     : ${cronThreadJob.name}`,
              `  Enabled  : ${cronThreadJob.enabled ? 'yes \u2705' : 'no \u23f8'}`,
              `  Schedule : ${formatCronSched(cronThreadJob)}`,
              `  Runtime  : ${cronThreadJob.runtime}`,
              ...(cronThreadJob.runtime === 'local' ? [
                `  Desc     : ${'description' in cronThreadJob.payload ? (cronThreadJob.payload as { description: string }).description.slice(0, 120) : '(none)'}`,
                `  Script   : world/crons/${cronThreadJob.id}/run.mjs ${cronScriptExists ? '\u2705 exists' : '\u26a0\ufe0f not written yet'}`,
              ] : [
                `  Payload  : docker \u2014 "${'title' in cronThreadJob.payload ? (cronThreadJob.payload as { title: string }).title.slice(0, 60) : ''}" / ${'priority' in cronThreadJob.payload ? ((cronThreadJob.payload as { priority?: string }).priority ?? 'normal') : 'normal'}`,
              ]),
              `  Runs     : ${cronThreadJob.state.runCount ?? 0} total${cronThreadJob.state.lastRunAtMs ? ` | last: ${new Date(cronThreadJob.state.lastRunAtMs).toISOString().slice(11, 19)}Z [${cronThreadJob.state.lastStatus ?? '?'}]` : ''}`,
              `  Next run : ${cronThreadJob.state.nextRunAtMs ? new Date(cronThreadJob.state.nextRunAtMs).toISOString().slice(11, 19) + 'Z' : '\u2014'}`,
            ].join('\n')
          : `This message came from a cron jobs forum thread (channel: ${channelId}), but no matching cron job exists in the store — the job may have been deleted.\nOffer to recreate it: ask the operator to describe what they want, then construct /cron add JSON and confirm before queuing.`,
      ] : []),
    ].join('\n');

    // Load Discord bot MCP config from .claude/mcp-servers.json (bot-specific).
    // Task runner sandbox uses world/shared/mcp-servers.json separately.
    let mcpServers: Record<string, unknown> = {};
    try {
      const raw = await readFile(join(workspaceRoot, '.claude/mcp-servers.json'), 'utf8');
      mcpServers = JSON.parse(raw) as Record<string, unknown>;
    } catch { /* not configured — fine */ }

    // ── Build prompt — branches on channel type ─────────────────────────
    // Text channel: isolated workspace assistant (cwd = world/text-channels/<id>/)
    // All other channels: world management operator assistant (existing behaviour)
    const prompt = isTextChannel
      ? (sessionId
          // Resume text channel session — inject fresh world state as read-only context
          ? [
              `## Your workspace: world/text-channels/${channelId}/`,
              `(cwd is set to this directory — use relative paths for files)`,
              '',
              worldContext,
              ...(threadHistory ? [
                '',
                '## Recent conversation history',
                compressThreadHistory(threadHistory),
              ] : []),
              '',
              `User: ${userMessage}`,
            ].join('\n')
          // New text channel session — full instructions
          : [
              'You are Vibe Guild, an AI assistant in a Discord text channel.',
              '',
              '## Your isolated workspace',
              `Working directory (cwd) is set to: ${textChannelDir}`,
              'Write all output files here using relative paths.',
              'Each Discord channel has its own independent workspace — do NOT write outside it.',
              '',
              '## Capabilities',
              '- Read/write files in your workspace',
              '- Run Bash commands (cwd = your workspace)',
              '- Web search and fetch',
              '- Read Vibe Guild world state (tasks, cron jobs) — read-only reference only',
              '- Trigger Vibe Guild world operations via Bash:',
              `    node ${join(workspaceRoot, 'scripts/vg-cmd.mjs')} cmd "/task <description>" ${channelId}`,
              `    node ${join(workspaceRoot, 'scripts/vg-cmd.mjs')} cmd "/revise <8-char-id> <feedback>"`,
              '',
              '## Rules',
              '- Respond in the same language as the user (Chinese if they write Chinese, English otherwise).',
              '- For read-only queries (status, questions): answer immediately from world context — no tools needed.',
              '- For code/file work: write to your workspace (cwd). Never write outside it.',
              '- For creating NEW world tasks or revising existing ones: confirm with the user first, then queue via vg-cmd.mjs.',
              '',
              worldContext,
              ...(threadHistory ? [
                '',
                '## Recent conversation history in this channel',
                '(Messages above this @mention)',
                compressThreadHistory(threadHistory),
              ] : []),
              '',
              `User: ${userMessage}`,
            ].join('\n')
        )
      // World management prompt (control-plane, task threads, cron threads)
      // First call (no session): include role + behaviour instructions.
      // On resume: just inject fresh world state so Claude has the current task list.
      : (sessionId
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
          '  `node scripts/vg-cmd.mjs cmd "/list-threads"`  ← list all active Discord posts in #tasks',
          '  `node scripts/vg-cmd.mjs cmd "/del-thread <channelId>"`  ← delete a Discord thread/post by channel ID',
          '  (The channel ID after /task tells the world to reuse this Discord post as the task thread.)',
          '',
          '## Cron Job Management',
          '- `node scripts/vg.mjs cron` — list all cron jobs (read-only, use this first to inspect)',
          '- `node scripts/vg-cmd.mjs cmd "/cron list"` — list via world command',
          `- \`node scripts/vg-cmd.mjs cmd "/cron add <json>" ${channelId}\` — add a new cron job (passing ${channelId} links it to THIS thread — no new forum post is created)`,
          '- `node scripts/vg-cmd.mjs cmd "/cron remove <8-char-id>"` — delete a cron job',
          '- `node scripts/vg-cmd.mjs cmd "/cron enable <8-char-id>"` — enable a cron job',
          '- `node scripts/vg-cmd.mjs cmd "/cron disable <8-char-id>"` — disable a cron job',
          '- `node scripts/vg-cmd.mjs cmd "/cron run <8-char-id>"` — fire a cron job immediately',
          '',
          'Cron job JSON schema for /cron add:',
          '',
          'runtime: "local" (inline, no container):',
          '```json',
          '{',
          '  "name": "Hello World",',
          '  "enabled": true,',
          '  "runtime": "local",',
          '  "schedule": { "kind": "every", "everyMs": 10000 },',
          '  "payload": { "description": "Posts hello world and current timestamp" }',
          '}',
          '```',
          '',
          'runtime: "docker" (spawns AI Task in Docker container):',
          '```json',
          '{',
          '  "name": "Weekly review",',
          '  "enabled": true,',
          '  "runtime": "docker",',
          '  "schedule": { "kind": "cron", "expr": "0 9 * * 1", "tz": "Asia/Shanghai" },',
          '  "payload": { "title": "Weekly review", "description": "Review progress and plan next week", "priority": "normal" }',
          '}',
          '```',
          'Schedule kinds: cron (5-field expr + optional tz), every (everyMs: milliseconds), at (ISO datetime string).',
          'IMPORTANT: Always confirm with the operator before adding, removing, or disabling a cron job.',
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
          '- For /del-thread (deleting Discord posts): ALWAYS confirm first. Show the operator which thread ID and name will be deleted, then ask "shall I proceed?". Only queue the delete command after explicit confirmation.',
          '- For /list-threads: call immediately, no confirmation needed.',
          ...(threadTask ? [
            '- **You are inside a task thread. Any code work (fix, test, build, run, or reading a GitHub repo) must go through /revise in Docker — do NOT use Bash to write/edit files, clone repos, run npm/git, or fetch GitHub content directly. Reading local world state files via Bash is fine.**',
          ] : []),
          ...(isCronThread ? [
            '- **You are inside a cron job\u2019s Discord forum post.**',
            '  - Your primary focus is this specific cron job (see \'## Cron Thread Context\' in the world state above).',
            '  - For read-only queries (show config, explain what it does, check status): answer immediately from context — no tool calls needed.',
            '  - For enable / disable / run: queue immediately, no confirmation needed — these are instantly reversible.',
            '  - For remove or schedule/payload changes: show the operator what you will change and confirm before queuing.',
            '  - If the job is missing (deleted from store): say so clearly, offer to recreate it. Ask: "What should this job do? Describe the schedule and action." Then build the /cron add JSON and confirm before queuing.',
            `  - To act: \`node scripts/vg-cmd.mjs cmd "/cron enable|disable|run|remove ${cronThreadJobId ?? '<id>'}"\``,
            '  - To recreate: `node scripts/vg-cmd.mjs cmd "/cron add <json>"`',
            ...(cronThreadJob?.runtime === 'local' ? [
              `  - **This is a local runtime job.** The script that runs each tick is at: \`world/crons/${cronThreadJob.id}/run.mjs\``,
              `    Script status: ${cronScriptExists ? '\u2705 exists' : '\u26a0\ufe0f not yet written'}.`,
              '    You can write or update it using Bash. The script must be a self-contained Node.js ESM module.',
              '    Whatever it prints to stdout will be posted to this thread after each run.',
              '    Example to write: `echo \'console.log("Hello World! " + new Date().toISOString())\' > world/crons/<id>/run.mjs`',
              '    Or write a full multi-line script using a heredoc / Bash file write.',
              '    After writing the script, tell the operator what it does and offer to enable the job.',
            ] : []),
          ] : []),
          '',
          worldContext,
          // Include thread history when available (especially important after a restart when
          // the SDK session is gone but the Discord thread already has conversation context).
          ...(threadHistory ? [
            '',
            '## Recent conversation history in this Discord thread (read-only context)',
            '(These are the messages that appeared above your @mention in this thread.)',
            compressThreadHistory(threadHistory),
          ] : []),
          '',
          `Operator: ${userMessage}`,
        ].join('\n')
        );

    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    // Note: do NOT forward ANTHROPIC_MODEL_ID to the SDK — it is the BigModel
    // proxy model name (GLM-5) and is not understood by the Claude Code SDK.
    // The SDK uses the claude CLI which manages its own model selection.
    const sdkOptions: Record<string, unknown> = {
      allowedTools: ['Read', 'Write', 'Bash', 'WebSearch', 'WebFetch'],
      settingSources: ['project'],
      permissionMode: 'bypassPermissions',
      maxTurns: 50,
      ...(sessionId ? { resume: sessionId } : {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      // Text channels: set isolated working directory so all file ops stay scoped
      ...(isTextChannel ? { cwd: textChannelDir } : {}),
    };

    let newSessionId: string | null = sessionId;
    let finalReply = '';

    const channelType = isTextChannel ? 'text' : isControlPlane ? 'control-plane' : isCronThread ? 'cron' : 'task';
    console.log(`[Discord/SDK] query() start – channel=${channelId} type=${channelType} resume=${!!sessionId}`);
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
        // Register cron thread before createTaskThread so it skips tasks-forum post creation
        if (task.discordThreadId) { registerExistingThread(task.id, task.discordThreadId); cronTaskIds.add(task.id); }
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

  // ── Cron scheduler ───────────────────────────────────────────────────────
  await startCronScheduler();
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

