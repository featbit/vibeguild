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
import {
  startClock,
  triggerMeetupFreeze,
  triggerMeetupResume,
} from './scheduler/clock.js';
import { createWorldMcpServer } from './tools/report.js';
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
      `  The engine will automatically start a TaskRunner for each assigned task.`,
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
  let frozen = false;    // true during global meetup
  let resting = false;   // true between SHIFT_REST_START and SHIFT_DAY_END
  let schedulerBusy = false;

  // Shared base options for all query() calls
  const mcpServer = await createWorldMcpServer();
  const baseOptions: Record<string, unknown> = {
    allowedTools: ['Read', 'Write', 'Bash', 'Task', 'WebSearch', 'WebFetch'],
    settingSources: ['project'],
    permissionMode: 'bypassPermissions',
    ...(process.env.ANTHROPIC_MODEL_ID ? { model: process.env.ANTHROPIC_MODEL_ID } : {}),
    ...(mcpServer ? { mcpServers: { 'vibe-guild-world-tools': mcpServer } } : {}),
  };

  // Options for TaskRunner instances
  const runnerOpts = {
    mcpServer,
    modelId: process.env.ANTHROPIC_MODEL_ID,
    onComplete: (taskId: string) => { activeRunners.delete(taskId); },
    onError: (taskId: string) => { activeRunners.delete(taskId); },
  };

  // ── Startup ──────────────────────────────────────────────────────────────
  await markWorldStarted();
  startClock();

  const initialBeings = await listBeings();
  const state = await readWorldState();
  console.log(`\n🌍 Vibe Guild is alive. Day ${state.dayCount + 1} starting.`);
  console.log(`   Beings: ${initialBeings.length > 0 ? initialBeings.join(', ') : 'none yet (will be created as needed)'}`);
  console.log(`   Shift: 8 min work → 2 min rest = 10 min day\n`);

  // ── Recover in-progress tasks from a previous run ────────────────────────
  {
    const savedTasks = await getAllTasks();
    const recovering = savedTasks.filter((t) => t.status === 'in-progress' && t.assignedTo?.length);
    for (const task of recovering) {
      console.log(`\n♻️  [World] Recovering task ${task.id.slice(0, 8)}: "${task.title}"`);
      const runner = createTaskRunner(task, runnerOpts);
      activeRunners.set(task.id, runner);
      void runner.start(task);
    }
  }

  // ── Stdin (human operator) ───────────────────────────────────────────────
  process.stdin.resume();
  const stdinRl = createInterface({ input: process.stdin });
  stdinRl.on('line', (line) => {
    const input = line.trim();
    if (!input) return;

    // /done or /resume — end meetup
    if (input === '/done' || input === '/resume') {
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

    // /task <desc> — quick-add task from terminal
    if (input.startsWith('/task ')) {
      const desc = input.slice(6).trim();
      void enqueueTask({ title: desc, description: desc, createdBy: 'human' }).then((task) => {
        console.log(`\n📋 Task added: ${task.id}\n`);
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

    // Default: global human message → next Orchestrator assignment turn
    globalHumanMessages.push(input);
    console.log(`\n💬 Message queued for Orchestrator (next assignment tick)\n`);
  });

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
        console.log(`\n🌄 [World] Day ${worldState.dayCount + 1} starting. Daily record written. Runners continue.`);
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
        console.log(`\n🚀 [World] Starting runner for task ${task.id.slice(0, 8)}: "${task.title}"`);
        const runner = createTaskRunner(task, runnerOpts);
        activeRunners.set(task.id, runner);
        void runner.start(task);
      }
    }

    // ── Orchestrator assignment turn (only when needed) ───────────────────
    const pendingTasks = await getPendingTasks();
    const messagesForThisTurn = globalHumanMessages.splice(0);
    const needsAssignment =
      pendingTasks.length > 0 ||
      messagesForThisTurn.length > 0 ||
      isFirstRun ||
      signals.some((s) => s.type === 'TASK_ADDED');

    if (!needsAssignment) return;

    const [busyBeings, worldState] = await Promise.all([getBusyBeings(), readWorldState()]);
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
              process.stdout.write(`\n[Orchestrator] ${block['text'] as string}\n`);
            }
          }
        }
        if (m['result']) process.stdout.write(`\n[Orchestrator] Assignment turn complete.\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) {
        console.error(`\n[Orchestrator] Error: ${message}\n`);
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

