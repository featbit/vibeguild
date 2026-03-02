import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  updateTaskStatus,
} from './tasks/queue.js';
import { createTaskRunner, type WorldTaskRunner } from './tasks/runner.js';
import { loadRuntimeConfig } from './runtime/config.js';
import { triggerMeetupFreeze } from './scheduler/clock.js';
import { startCronScheduler } from './cron/scheduler.js';
import { createWorldMcpServer } from './tools/report.js';


// ─── World Engine ─────────────────────────────────────────────────────────────

const log = (msg: string): void => { console.log(`\n${msg}`); };

const runWorldLoop = async (): Promise<void> => {

  // ── State ────────────────────────────────────────────────────────────────
  const activeRunners = new Map<string, WorldTaskRunner>();
  // Tasks frozen by a task-level meetup (not globally frozen)
  const frozenTaskIds: string[] = [];
  let frozen = false;       // true during global meetup
  let resting = false;      // true between SHIFT_REST_START and SHIFT_DAY_END
  let schedulerBusy = false;
  // Tracks which task is currently in alignment (waiting_for_human) — for display only
  let aligningTaskId: string | null = null;

  const mcpServer = await createWorldMcpServer();

  // Options for TaskRunner instances
  const runnerOpts = {
    mcpServer,
    modelId: process.env.ANTHROPIC_MODEL_ID,
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

      // Enter alignment mode when leader needs human input.
      // Do NOT docker-pause the container — entrypoint is actively polling inbox.
      // All terminal input will be routed directly to this task's inbox until
      // the leader resumes on its own (writes status != 'waiting_for_human').
      if (p.status === 'waiting_for_human' && aligningTaskId !== p.taskId) {
        aligningTaskId = p.taskId;
        const question = p.question ?? p.summary;
        console.log(`\n🤔 [task:${short}] Agent needs input:`);
        console.log(`   "${question}"`);
        console.log(`   ► Use: node scripts/vg-write.mjs inject-message ${short} "<your reply>"\n`);

      } else if (p.status === 'waiting_for_human' && aligningTaskId === p.taskId) {
        const question = p.question ?? p.summary;
        console.log(`\n💬 [task:${short}] ${question}`);
        console.log(`   ► node scripts/vg-write.mjs inject-message ${short} "<reply>"\n`);

      }

      // Auto-exit alignment mode when agent resumes on its own
      if (aligningTaskId === p.taskId && p.status !== 'waiting_for_human') {
        aligningTaskId = null;
        console.log(`\n✅ [task:${short}] Alignment resolved. Resuming task.\n`);
      }

      // Post final output summary when the task is done
      if ((p.status === 'completed' || p.status === 'failed') && !runnerOpts._seenFinalOutput.has(p.taskId)) {
        runnerOpts._seenFinalOutput.add(p.taskId);
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
              log(lines.join('\n'));
              for (const f of files) {
                const content = (await readFile(join(messagesDir, f), 'utf8')).trim();
                log(content);
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
          log(lines.join('\n'));
        })();
        return;
      }
    },
    onComplete: (taskId: string) => { activeRunners.delete(taskId); },
    onError: (taskId: string) => { activeRunners.delete(taskId); },
    onLog: (msg: string) => { log(msg); },
  };

  // ── Graceful shutdown: flush Discord before exit ─────────────────────────
  const onExit = () => { process.exit(0); };
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

  // ── Recover in-progress tasks from a previous run ────────────────────────
  {
    const savedTasks = await getAllTasks();
    const recovering = savedTasks.filter((t) => t.status === 'in-progress');
    for (const task of recovering) {
      console.log(`\n♻️  [World] Recovering task ${task.id.slice(0, 8)}: "${task.title}"`);
      const runner = createTaskRunner(task, runnerOpts);
      activeRunners.set(task.id, runner);
      void runner.start(task);
    }
  }

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
      console.log(`   To resume: node scripts/vg-write.mjs resume\n`);
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
        console.log(`   Inject message: node scripts/vg-write.mjs inject-message ${fullId.slice(0, 8)} "<msg>"`);
        console.log(`   To resume: node scripts/vg-write.mjs resume --task ${fullId.slice(0, 8)}\n`);
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
      }
    }

    // ── Auto-assign pending tasks ─────────────────────────────────────────
    const pendingTasks = await getPendingTasks();
    for (const task of pendingTasks) {
      await updateTaskStatus(task.id, 'assigned');
      const ageMs = Date.now() - new Date(task.createdAt).getTime();
      const ageStr = ageMs < 60_000 ? `${Math.floor(ageMs / 1000)}s` : `${Math.floor(ageMs / 60_000)}m`;
      console.log(`\n📋 Task auto-assigned: ${task.id.slice(0, 8)}  [${task.priority}]  age:${ageStr}  "${task.title.slice(0, 72)}"`);
      void appendSignal('TASK_ADDED', { taskId: task.id });
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
      console.log(`   Inject message  : node scripts/vg-write.mjs inject-message ${opts.task.slice(0, 8)} "<msg>"`);
      console.log(`   Resume task     : node scripts/vg-write.mjs resume --task ${opts.task.slice(0, 8)}\n`);
    } else {
      await triggerMeetupFreeze();
      console.log(`\n❄️  Global freeze signal sent. All runners will pause.`);
      console.log(`   Resume all      : node scripts/vg-write.mjs resume\n`);
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

