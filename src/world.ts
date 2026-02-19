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
import { enqueueTask, getPendingTasks, getTaskSummary, getBusyBeings } from './tasks/queue.js';
import { startClock, triggerMeetupFreeze, triggerMeetupResume, registerInterruptCallback } from './scheduler/clock.js';
import { createWorldMcpServer } from './tools/report.js';
import type { WorldSignal } from './memory/types.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  label?: string;
};

/**
 * Retries an async function with exponential backoff.
 * Only retries on errors that look like timeouts or rate limits.
 * All other errors are rethrown immediately after logging.
 */
const withRetry = async <T>(
  fn: () => Promise<T>,
  { maxAttempts = 3, baseDelayMs = 10_000, label = 'operation' }: RetryOptions = {},
): Promise<T> => {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const message = err instanceof Error ? err.message : String(err);
      const isRetryable = /timeout|timed.?out|rate.?limit|overload|529|503|econnreset|socket/i.test(message);
      if (!isRetryable || attempt >= maxAttempts) {
        if (attempt > 1) {
          console.error(`\n[World] ${label} failed after ${attempt} attempt(s): ${message}\n`);
        }
        throw err;
      }
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1); // 10s → 20s → 40s
      console.error(
        `\n[World] ${label} error (attempt ${attempt}/${maxAttempts}): ${message}` +
        `\n        Retrying in ${delayMs / 1000}s (exponential backoff)...\n`,
      );
      await sleep(delayMs);
    }
  }
};

// ─── prompt builder ───────────────────────────────────────────────────────────

type PromptContext = {
  isFirstRun: boolean;
  dayCount: number;
  signals: WorldSignal[];
  pendingTasks: import('./tasks/types.js').Task[];
  humanMessages: string[];
  allBeings: string[];
  busyBeings: string[];
};

const buildOrchestratorPrompt = (ctx: PromptContext): string => {
  const parts: string[] = [];

  if (ctx.isFirstRun) {
    parts.push(
      `You are the Orchestrator of Vibe Guild. The world is starting up for the first time.`,
      `Review the world memory at \`world/memory/world.json\` and the task queue at \`world/tasks/queue.json\`.`,
      `Check if any beings exist in \`world/beings/\` yet. If no beings have profiles, this is a fresh world.`,
      `Greet the three beings (Aria, Bram, Cleo) and orient them: explain what Vibe Guild does and what the first task will be.`,
      `If there is a pending task in the queue, assign it to an appropriate team of beings.`,
    );
  } else {
    parts.push(`Continuing Vibe Guild operations. Day ${ctx.dayCount}.`);
  }

  if (ctx.signals.length > 0) {
    parts.push(`\n--- PENDING WORLD SIGNALS (process these immediately) ---`);
    for (const signal of ctx.signals) {
      parts.push(`• ${signal.type}: ${JSON.stringify(signal.payload ?? {})}`);
    }
    parts.push(`---`);
    parts.push(
      `Handle each signal before other work:`,
      `• SHIFT_REST_START → broadcast rest signal to active teammates, instruct them to write shift summaries`,
      `• SHIFT_DAY_END → ensure beings have completed rest tasks, write daily record to world/memory/daily/, announce new day`,
      `• MEETUP_FREEZE → broadcast freeze to all teammates, confirm they are suspended, await further human messages`,
      `• MEETUP_RESUME → broadcast resume to all teammates`,
    );
  }

  // Always show being pool so Orchestrator can make assignment decisions
  {
    const free = ctx.allBeings.filter((b) => !ctx.busyBeings.includes(b));
    parts.push(`\n--- BEING POOL ---`);
    parts.push(`All beings: ${ctx.allBeings.length > 0 ? ctx.allBeings.join(', ') : 'none yet'}`);
    if (ctx.busyBeings.length > 0) {
      parts.push(`Busy (already on a task — do NOT assign more work): ${ctx.busyBeings.join(', ')}`);
    }
    parts.push(`Free (available now): ${free.length > 0 ? free.join(', ') : 'none'}`);
    parts.push(``);
    parts.push(`ASSIGNMENT STRATEGY (follow in order):`);
    parts.push(`  1. Assign free existing beings to new tasks first.`);
    parts.push(`  2. If a task needs more beings than are currently free, CREATE new beings for the remainder.`);
    parts.push(`  3. There is NO upper limit on beings. Grow the pool whenever needed.`);
    parts.push(``);
    parts.push(`HOW TO CREATE A NEW BEING (do all 3 steps before assigning them):`);
    parts.push(`  a. Choose a lowercase name (e.g. dana, evan, felix, grace…).`);
    parts.push(`  b. Read \`.claude/agents/_template.md\` — copy it, fill in all {PLACEHOLDERS} for their role, save to \`.claude/agents/{name}.md\`.`);
    parts.push(`  c. Write \`world/beings/{name}/profile.json\` with: id, name, role, description, skills[], status:"idle", createdAt.`);
    parts.push(`     (The engine auto-creates the directory skeleton when it detects a new profile.json.)`);
    parts.push(`RULE: Each being may only work on ONE task at a time.`);
    parts.push(`---`);
  }

  if (ctx.pendingTasks.length > 0) {
    parts.push(`\n--- TASK QUEUE STATUS ---`);
    parts.push(`There are ${ctx.pendingTasks.length} pending task(s) awaiting assignment:`);
    for (const t of ctx.pendingTasks) {
      const cap = t.maxBeings !== undefined
        ? ` [MAX BEINGS: ${t.maxBeings} — hard limit, sequence work rather than parallelise]`
        : '';
      parts.push(`• [${t.priority.toUpperCase()}] ${t.id.slice(0, 8)} — ${t.title}${cap}`);
    }
    parts.push(
      `Read \`world/tasks/queue.json\` for full details and assign tasks to available beings only.`,
      `Respect each task's MAX BEINGS limit if set — do NOT spawn more teammates than allowed for that task.`,
      `---`,
    );
  }

  if (ctx.humanMessages.length > 0) {
    parts.push(`\n--- MESSAGES FROM HUMAN OPERATOR ---`);
    for (const msg of ctx.humanMessages) {
      parts.push(`> ${msg}`);
    }
    parts.push(
      `---`,
      `Respond to the human operator's messages. If they give new tasks, add them to the queue and assign them.`,
    );
  }

  if (parts.length === (ctx.isFirstRun ? 5 : 1) && ctx.pendingTasks.length === 0 && ctx.humanMessages.length === 0) {
    // No special signals or messages — just continue normal work
    parts.push(
      `Continue coordinating the team's work.`,
      `Check \`world/tasks/queue.json\` for any pending tasks needing assignment.`,
      `Check on active teammates via their shift summaries in \`world/beings/*/memory/shifts/\`.`,
      `If a being has been idle for too long without a task, assign them something from the backlog.`,
      `Escalate anything requiring human attention using the escalateToHuman tool (or Write to \`world/reports/escalations.json\`).`,
    );
  }

  return parts.join('\n');
};

// ─── message handler ──────────────────────────────────────────────────────────

type SdkMessage = {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  content?: Array<{ type: string; text?: string }>;
};

const handleMessage = async (
  msg: unknown,
  onSessionId: (id: string) => void,
): Promise<void> => {
  const m = msg as SdkMessage;

  // Capture session ID from init message
  if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
    onSessionId(m.session_id);
    return;
  }

  // Print assistant text to stdout
  if (m.type === 'assistant' && Array.isArray(m.content)) {
    for (const block of m.content) {
      if (block.type === 'text' && block.text) {
        process.stdout.write(`\n[Orchestrator] ${block.text}\n`);
      }
    }
    return;
  }

  // Print final result
  if (m.result) {
    process.stdout.write(`\n[World] Turn complete.\n`);
  }
};

// ─── world loop ───────────────────────────────────────────────────────────────

const runWorldLoop = async (): Promise<void> => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  let sessionId = await readSessionId();
  let isFirstRun = !sessionId;
  const humanMessages: string[] = [];
  let frozen = false;
  let resting = false; // true during SHIFT_REST_START → SHIFT_DAY_END gap

  // AbortController for the current query() call.
  // Replaced each turn; abort() is called by the clock or meetup freeze.
  let currentAbort: AbortController | null = null;

  const interruptCurrentTurn = (): void => {
    if (currentAbort && !currentAbort.signal.aborted) {
      console.log(`\n✋ [World] Interrupting current turn (clock or freeze signal).`);
      currentAbort.abort();
    }
  };

  registerInterruptCallback(interruptCurrentTurn);

  await markWorldStarted();
  startClock();

  console.log(`\n🌍 Vibe Guild is alive. Day ${(await readWorldState()).dayCount + 1} starting.`);
  console.log(`   Beings: Aria (researcher), Bram (strategist), Cleo (writer)`);
  console.log(`   Shift: 8 min work → 2 min rest = 10 min day\n`);

  // Load optional in-process MCP server for custom tools
  const mcpServer = await createWorldMcpServer();

  // Listen for stdin input (human operator messages during freeze or anytime)
  process.stdin.resume();
  const stdinRl = createInterface({ input: process.stdin });
  stdinRl.on('line', (line) => {
    const input = line.trim();
    if (!input) return;

    if (input === '/done' || input === '/resume') {
      frozen = false;
      void writeRuntimeState({ frozen: false, resting });
      void triggerMeetupResume();
      console.log(`\n▶️  Meetup ended. Beings resuming work.\n`);
      return;
    }

    if (input.startsWith('/task ')) {
      const description = input.slice(6).trim();
      void enqueueTask({ title: description, description, createdBy: 'human' }).then((task) => {
        console.log(`\n📋 Task added: ${task.id}\n`);
        void appendSignal('TASK_ADDED', { taskId: task.id });
      });
      return;
    }

    // Human message injected into world
    humanMessages.push(input);
    if (!frozen) {
      console.log(`\n💬 Message queued for Orchestrator (will inject on next turn)\n`);
    } else {
      console.log(`\n💬 Orchestrator will see this message\n`);
    }
  });

  // ─── base query options (static, built once) ────────────────────────────────
  const baseQueryOptions: Record<string, unknown> = {
    allowedTools: ['Read', 'Write', 'Bash', 'Task', 'WebSearch', 'WebFetch'],
    settingSources: ['project'],
    permissionMode: 'bypassPermissions',
    ...(process.env.ANTHROPIC_MODEL_ID ? { model: process.env.ANTHROPIC_MODEL_ID } : {}),
  };
  if (mcpServer) {
    baseQueryOptions.mcpServers = { 'vibe-guild-world-tools': mcpServer };
  }

  // Build full options for a query call — adds dynamic resume + per-call overrides.
  const buildQueryOptions = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...baseQueryOptions,
    ...(sessionId ? { resume: sessionId } : {}),
    ...overrides,
  });

  // ─── rest turn prompt ──────────────────────────────────────────────────────
  // Runs immediately after SHIFT_REST_START. Orchestrator instructs all beings
  // to write shift summaries and self-notes. This is the "dream consolidation"
  // phase — beings process what happened and commit it to memory files.
  const buildRestPrompt = (dayCount: number, beings: string[]): string => {
    const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const taskBlocks = beings.map((id) => [
      `Task for ${id}:`,
      `  "REST PERIOD — Write your shift summary for Day ${dayCount} to:`,
      `  world/beings/${id}/memory/shifts/${ts}.json`,
      `  Include: what tasks you worked on, key decisions, what you learned, follow-ups needed.`,
      `  Also write any self-notes worth keeping to world/beings/${id}/memory/self-notes/${ts}.json`,
      `  If you did nothing this shift, still write the file with an honest account. Do it now."`,
    ].join('\n'));
    return [
      `SHIFT REST PERIOD — Day ${dayCount}. Work period is over. No new tasks.`,
      ``,
      `You MUST now use the Task tool to spawn a separate Task call for EACH being listed below.`,
      `Do not batch multiple beings into one Task call. Each being writes their own summary independently.`,
      ``,
      ...taskBlocks.flatMap((block) => [block, '']),
      `Spawn all ${beings.length} Task calls now. Wait for all to complete. Then you are done.`,
    ].join('\n');
  };

  // Main world loop
  while (true) {
    if (frozen) {
      await sleep(1000);
      continue;
    }

    const signals = await drainPendingSignals();

    // Handle freeze signal
    const freezeSignal = signals.find((s) => s.type === 'MEETUP_FREEZE');
    if (freezeSignal) {
      frozen = true;
      void writeRuntimeState({ frozen: true, resting });
      interruptCurrentTurn();
      console.log(`\n❄️  World frozen for meetup. Type your messages. Type /done to resume.\n`);
    }

    // Handle rest start — run a dedicated rest turn so beings write summaries
    const restSignal = signals.find((s) => s.type === 'SHIFT_REST_START');
    if (restSignal && !resting) {
      resting = true;
      void writeRuntimeState({ frozen, resting: true });
      console.log(`\n⏸  [World] Rest period started — running shift consolidation turn.`);
      const dayCount = (await readWorldState()).dayCount;
      const beings = await listBeings();
      const restPrompt = buildRestPrompt(dayCount, beings);
      try {
        currentAbort = new AbortController();
        for await (const msg of query({
          prompt: restPrompt,
          options: buildQueryOptions({ maxTurns: 8, abortController: currentAbort }) as Parameters<typeof query>[0]['options'],
        })) {
          await handleMessage(msg, (id) => {
            sessionId = id;
            void writeSessionId(id);
          });
          if (currentAbort.signal.aborted) break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/abort/i.test(msg)) {
          console.error(`\n[World] Rest turn error: ${msg}\n`);
        }
      }
      console.log(`\n⏸  [World] Shift consolidation complete. Waiting for day end...`);
    }

    // Handle day end — engine writes daily record, end rest
    const dayEndSignal = signals.find((s) => s.type === 'SHIFT_DAY_END');
    if (dayEndSignal) {
      const state = await incrementDay();
      const today = new Date().toISOString().slice(0, 10);
      // Gather actual data: count shift files written today by each being (dynamic pool)
      const allKnownBeings = await listBeings();
      const beingsWithShifts: string[] = [];
      for (const b of allKnownBeings) {
        const shifts = await listTodayShifts(b, today);
        if (shifts.length > 0) beingsWithShifts.push(b);
      }
      const escalations = await readEscalations();
      const todayEscalations = escalations.filter((e) =>
        e.createdAt.startsWith(today),
      );
      await writeDailyRecord({
        date: today,
        dayCount: state.dayCount,
        beingsActive: beingsWithShifts.length > 0 ? beingsWithShifts : allKnownBeings,
        tasksCompleted: state.completedProjects ?? [],
        tasksInProgress: [],
        escalationCount: todayEscalations.length,
        keyEvents: [`Day ${state.dayCount} ended at ${new Date().toISOString()}`],
        writtenAt: new Date().toISOString(),
      });
      if (resting) {
        resting = false;
        void writeRuntimeState({ frozen, resting: false });
        console.log(`\n🌄 [World] New day ${state.dayCount + 1} starting — resuming work.`);
      }
    }

    // Skip building a work prompt if we just handled rest/day-end with no other signals
    if (resting) {
      await sleep(1000);
      continue;
    }

    // Collect human messages for this turn
    const messagesForThisTurn = humanMessages.splice(0, humanMessages.length);
    const [pendingTasks, busyBeings, allBeings, worldState] = await Promise.all([
      getPendingTasks(),
      getBusyBeings(),
      listBeings(),
      readWorldState(),
    ]);

    // Auto-scaffold directories for any newly created beings (idempotent)
    await Promise.all(allBeings.map((id) => createBeingDirectories(id)));

    const prompt = buildOrchestratorPrompt({
      isFirstRun,
      dayCount: worldState.dayCount,
      signals: signals.filter((s) => s.type !== 'MEETUP_FREEZE' && s.type !== 'SHIFT_REST_START'),
      pendingTasks,
      humanMessages: messagesForThisTurn,
      allBeings,
      busyBeings,
    });

    isFirstRun = false;

    try {
      await withRetry(
        async () => {
          currentAbort = new AbortController();
          for await (const msg of query({
            prompt,
            options: buildQueryOptions({ maxTurns: 15, abortController: currentAbort }) as Parameters<typeof query>[0]['options'],
          })) {
            await handleMessage(msg, (id) => {
              sessionId = id;
              void writeSessionId(id);
            });
            // Break immediately if aborted (freeze or clock interrupt)
            if (currentAbort.signal.aborted) break;
          }
        },
        { maxAttempts: 3, baseDelayMs: 10_000, label: 'world turn' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // AbortError is expected on interrupt — not an error
      if (/abort/i.test(message)) {
        console.log(`\n[World] Turn interrupted cleanly.\n`);
        await sleep(1_000);
        continue;
      }
      // Non-retryable or exhausted retries — log and continue to next turn
      console.error(`\n[World] Turn skipped after retries: ${message}. Continuing in 15s...\n`);
      await sleep(15_000);
    }

    // Brief pause between world turns to avoid rate limits
    await sleep(5_000);
  }
};

// ─── commands ─────────────────────────────────────────────────────────────────

program
  .name('vibe-guild')
  .description('Vibe Guild — autonomous AI world for FeatBit vibe marketing')
  .version('0.1.0');

program
  .command('start')
  .description('Start the world — runs the Orchestrator in a continuous loop')
  .action(() => {
    void runWorldLoop();
  });

program
  .command('task <description>')
  .description('Add a task to the world task queue')
  .option('-p, --priority <priority>', 'Priority: low | normal | high | critical', 'normal')
  .option('--plan', 'Require plan approval before execution', false)
  .option(
    '--max-beings <n>',
    'Max beings the Orchestrator may assign to this task (limits concurrent LLM calls)',
  )
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
    if (maxBeings !== undefined) {
      console.log(`   Max beings:  ${maxBeings}`);
    }
    console.log(`\n   The Orchestrator will pick this up on the next world turn.\n`);
    process.exit(0);
  });

program
  .command('meetup')
  .description('Freeze all beings and open a human meetup channel')
  .action(async () => {
    await triggerMeetupFreeze();
    console.log(`\n❄️  Freeze signal sent to the running world.`);
    console.log(`   The Orchestrator will suspend all beings on its next turn.`);
    console.log(`   To communicate during the meetup, type directly in the world's terminal.`);
    console.log(`   Type /done in the world terminal to resume.\n`);
    process.exit(0);
  });

program
  .command('status')
  .description('Show world status: day count, task queue summary, signals')
  .action(async () => {
    const state = await readWorldState();
    const tasks = await getTaskSummary();
    const { readSignals, readRuntimeState } = await import('./memory/store.js');
    const signals = await readSignals();
    const runtime = await readRuntimeState();
    const pending = signals.filter((s) => !s.processed);

    const worldMode = runtime.frozen ? '❄️  FROZEN (meetup)' : runtime.resting ? '⏸  RESTING (shift rest)' : '▶️  RUNNING';

    console.log(`\n🌍 Vibe Guild Status`);
    console.log(`   Mode:    ${worldMode}`);
    console.log(`   Day:     ${state.dayCount}`);
    console.log(`   Started: ${state.startedAt ?? 'not yet'}`);
    if (runtime.updatedAt) console.log(`   State updated: ${runtime.updatedAt}`);
    console.log(`\n📋 Tasks`);
    console.log(`   Pending:     ${tasks.pending}`);
    console.log(`   In Progress: ${tasks.inProgress}`);
    console.log(`   Completed:   ${tasks.completed}`);
    console.log(`   Blocked:     ${tasks.blocked}`);
    console.log(`\n📡 Pending Signals: ${pending.length}`);
    for (const s of pending) {
      console.log(`   • ${s.type} (${s.createdAt})`);
    }
    console.log('');
    process.exit(0);
  });

program.parse(process.argv);

// Default: show help if no command given
if (process.argv.length < 3) {
  program.help();
}
