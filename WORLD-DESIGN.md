# Vibe Guild — Architecture Summary

## What It Is

Vibe Guild is an autonomous AI world for FeatBit's vibe marketing. A pool of AI beings
work continuously, self-organize into teams, and produce content around feature flags,
feature management, and AI coding. The human operator stays in control: they add tasks,
monitor progress, and can intervene at any point via **meetup** to redirect work, add
team members, or inject new requirements — after which tasks continue with the updated
direction.

**Core philosophy: the world is self-evolving.** After completing a World Task, beings
are expected to distill what they learned — writing new skills (`.md` guidance files)
and tools (TypeScript MCP functions) that did not exist before. These accumulate in
`world/shared/` and are promoted into the world engine, becoming available to every
being in future tasks. Each task leaves the world slightly more capable than it was.
This is the soul of Vibe Guild, even as the automation to enforce it is still being built.

## Tech Stack

- **Runtime**: `@anthropic-ai/claude-agent-sdk` `^0.2.47` (Claude Agent SDK, formerly Claude Code SDK)
- **Language**: TypeScript `^5.9.3` (ESM, `"type": "module"`, functional — no classes)
- **Coordination model**: subagent tree via `Task` tool (see below) — *not* Claude Code Agent Teams (see rationale in Subagent Execution Model)
- **Scheduler**: `node-cron` `^4.2.1` for shift clock
- **File watcher**: `chokidar` `^5.0.0` for sync daemon (Phase 7+)
- **CLI**: `commander` `^14.0.3`, `zod` `^4.3.6` for MCP tool schemas
- **Node**: `>=20.6.0` — uses native `--env-file` flag (no dotenv needed)

## Folder Structure

| Folder | Owner | Purpose |
|--------|-------|---------|
| `src/` | Human | World Engine — TypeScript code that runs the world (immutable laws) |
| `.claude/` | Human | World Law — CLAUDE.md, skills, being definitions (.md files) |
| `world/` | Beings | The Living World — memory, tasks, being-created tools/skills, task queue, reports |
| `output/` | Beings | Deliverables — blog drafts, insights, reports |

```
vibeguild/
├── src/
│   ├── scheduler/       shift clock, meetup triggers, freeze/resume
│   ├── memory/          read/write helpers for world/ folder
│   ├── tasks/           task queue, decomposition, dependency graph
│   ├── sync/            sync daemon: world/shared/ → src/tools/generated/
│   ├── tools/           built-in MCP tools (HN, Reddit, ingest, report, metatool)
│   │   └── generated/   synced from world/shared/tools/ — being-created tools
│   └── world.ts         main entrypoint (CLI: start | task | meetup)
├── .claude/
│   ├── CLAUDE.md        world memory + laws (always loaded by every being)
│   ├── skills/          world-level skills (human-defined + synced from world/)
│   └── agents/          30 being definitions as {id}.md files
└── world/
    ├── memory/
    │   ├── daily/        {date}.json — automated daily record
    │   ├── weekly/       {week}.json
    │   ├── monthly/      {month}.json
    │   ├── project/      {project-id}.json
    │   ├── team/         {team-id}.json
    │   └── world.json    cumulative world history + day counter
    ├── beings/
    │   └── {id}/
    │       ├── profile.json      identity, skills earned, task history
    │       └── memory/
    │           ├── shifts/       per-shift summaries (written by the being)
    │           └── self-notes/   things the being decides to record
    ├── shared/
    │   ├── tools/        tools validated and shared with the whole world
    │   └── skills/       skills shared across beings (synced → .claude/skills/)
    ├── tasks/
    │   ├── queue.json        shared task list
    │   └── {task-id}/
    │       └── progress.json  leader self-decides when to write (includes worldDay + checkpoints)
    ├── sessions/
    │   ├── orchestrator.json Orchestrator session ID for assignment turns
    │   └── tasks/
    │       └── {task-id}.json per-task session ID for runner resume
    └── reports/          escalations.json, meetup notes
```

## World Mechanics

### World Engine (Parallel Scheduler)

The core loop is a **5-second `setInterval` scheduler** (not a blocking `while(true)`).
This allows multiple tasks to execute concurrently — each as an independent `TaskRunner`.

```
setInterval(5 s) tick():
  1. drain world/signals.json
  2. MEETUP_FREEZE {taskId?} → hard abort: pause one runner or all runners
  3. SHIFT_REST_START → soft signal: inject rest message into each active runner
  4. SHIFT_DAY_END    → read observable state, write daily record, dayCount++
  5. newly assigned tasks not in registry → start new TaskRunner
  6. in-progress tasks not in registry (crash recovery) → resume TaskRunner
  7. pending tasks / human messages → short Orchestrator assignment turn
```

The Orchestrator is used **only for assignment** (short turns, `maxTurns: 10`).
Task execution is handled entirely by `TaskRunner` instances.

**Key principle:** the shift clock never interrupts a running task. It is a soft
logging cadence. Runners are only hard-interrupted by an explicit `meetup` command.

### TaskRunner

One `TaskRunner` per active task. Each owns:
- Its own `query()` call with a dedicated `AbortController`
- A session ID persisted to `world/sessions/tasks/{id}.json` on every init message
- A leader being responsible for progress reporting

**Lifecycle:**
```
start()  → launch query(); write session; leader begins work
pause()  → abort(); session already saved
resume() → re-enter query() with saved sessionId; leader reads progress.json and continues
```

**Parallel execution:** the scheduler holds `Map<taskId, TaskRunner>` — all runners run
concurrently as independent async Promises.

### Subagent Execution Model

Each `TaskRunner` runs a tree of **real, independent Claude instances** — not role-play
inside a single context. Every node in the tree has its own context window.

```
TaskRunner.query()            ← Orchestrator  (1 independent Claude instance)
    └─ Task tool → Leader     ← real subagent, own context
           ├─ Task tool → Being A   ← real subagent (can run in parallel with B)
           └─ Task tool → Being B   ← real subagent
```

**Being definitions vs instances**

| | When it exists |
|---|---|
| Being definition (`.claude/agents/{id}.md`) | Always — created ahead of time by Orchestrator or human |
| Being instance (running subagent) | Only when `Task("{id}", "...")` is called; destroyed when it returns |

**Information flow** is uni-directional up the tree. Being A's result enters Leader's
context automatically; Being B does NOT see A's result unless Leader explicitly includes
it in B's spawn prompt. Beings can only communicate through the Leader.

**Scheduling: serial vs parallel** — Leader decides based on task dependencies:

```
# Parallel (independent subtasks)
Leader → Task(A, "research X")  ─┐
Leader → Task(B, "research Y")  ─┘  both running simultaneously
         ← A result + B result both arrive in Leader context

# Serial (B depends on A's output)
Leader → Task(A, "analyse data")  →  ← A returns findings
Leader → Task(B, "write copy based on A's findings: ...")  ← Leader injects A's output

# Multi-round (same being called multiple times)
Leader → Task(A, "write draft")   ← A: first instance, returns draft
Leader → Task(B, "critique draft")← B: returns critique
Leader → Task(A, "revise: {critique}") ← A: second instance, new context
```

**`maxBeings`** = total number of *distinct* beings usable across the entire task
lifetime (including the leader). The same being can be called multiple times without
counting again. This is a prompt-level constraint communicated to the Leader.

**Assignment layer vs execution layer**

| Layer | Where | "Busy" concept |
|---|---|---|
| World Task assignment | `world/tasks/queue.json` + `getBusyBeings()` | A being can only be on one World Task at a time |
| Subagent execution | Leader's `Task` tool calls | No busy/idle — every call spawns a fresh instance |

**Why not Claude Code Agent Teams?**

Claude Code ships an experimental agent teams feature (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`)
that allows teammates to message each other directly via a shared Mailbox. We deliberately
do not use it, for several reasons:

| Reason | Detail |
|--------|--------|
| Experimental + unstable | Disabled by default; known bugs: no session resumption for in-process teammates, task status can lag, orphaned tmux sessions |
| No nested teams | Teammates cannot spawn their own teams. Our design needs the Leader to be able to spawn sub-teams dynamically. |
| Separate storage | Agent teams store config in `~/.claude/teams/` and tasks in `~/.claude/tasks/` — entirely separate from our `world/` filesystem. Integrating both would create two competing state systems. |
| Already running inside a session | Our `TaskRunner` is itself a `query()` call. A running session cannot become the "lead" of a new agent team. |
| Subagent tree is sufficient | The `Task` tool already gives us real parallel Claude instances. Inter-agent communication needs (A→B) are handled by the Leader acting as an explicit relay, which fits our single-source-of-truth design. |

If Claude Code Agent Teams stabilise and remove the nesting limitation, migration would be
straightforward: replace `Task` tool calls with Mailbox messages and point storage at `world/`.

### Shift Clock (MVP: 10-min day)

The clock fires **soft signals only** — it never pauses or interrupts a running task.
This is intentional: tasks may involve sandbox environments, open ports, file locks, or
long-running processes that cannot be safely interrupted mid-operation.

| Signal | What the engine does |
|--------|---------------------|
| `SHIFT_REST_START` (8 min) | Inject a rest message into each active runner via `injectMessage()`. The leader writes a progress checkpoint and shift summary at its next safe stopping point, then continues. |
| `SHIFT_DAY_END` (10 min) | Read all observable state (progress.json files, shift files, escalations) and write `world/memory/daily/{date}.json`. Increment `dayCount`. Runners are untouched. |

The rest message injected into each runner reads:
> *"Rest period. At your next convenient stopping point (between tool calls, not
> mid-operation): write a progress checkpoint to `progress.json` and a shift summary
> to `shifts/{ts}.json`. Then CONTINUE your work — do NOT stop or wait."*

Production cadence: 25 min work + 5 min rest (30-min day).

### Memory Hierarchy
- **Being memory**: private shift summaries + self-notes (being-initiated, not system-mandated)
- **Team memory**: `world/memory/team/{team-id}.json` — shared decisions, blockers, objectives
- **Project memory**: `world/memory/project/{id}.json` — cross-task context
- **Daily/weekly/monthly**: automated rollups; weekly = summary of 7 daily records
- **World record**: `world/memory/world.json` — cumulative history, completed projects

### Being Pool (dynamic, starts at zero)
- **No fixed roster**. World starts empty; beings are created on demand by the Orchestrator.
- Defined in `.claude/agents/{id}.md` (filesystem agent format — loaded automatically by Claude)
- Tracked in `world/beings/{id}/profile.json`
- Each being may only work on **one task at a time** — `getBusyBeings()` enforces this
- Assignment strategy (every Orchestrator turn):
  1. Assign free existing beings first
  2. If more capacity is needed, Orchestrator creates new beings from `_template.md`
  3. No upper limit — grow the pool whenever tasks demand it
- The engine auto-scaffolds `memory/shifts/`, `memory/self-notes/` etc. for each new being

### Team Formation + Leader Pattern
1. Orchestrator assigns a task: picks beings (creates new ones if needed), elects a **leader**
2. Task is written to `world/tasks/queue.json` with `status: "assigned"`, `leaderId`, `assignedTo[]`
3. Scheduler detects the newly assigned task → starts a `TaskRunner`
4. The TaskRunner spawns the leader via the `Task` tool; leader coordinates the team
5. **Leader responsibilities**:
   - Coordinate sub-tasks via the Task tool (spawn other beings)
   - **Self-decides** when to write a progress report — no forced cadence. Before writing,
     the leader reads `world/memory/world.json` to get the current `dayCount` and includes
     it in `world/tasks/{id}/progress.json`:
     ```json
     { "taskId": "...", "leaderId": "aria",
       "worldDay": 3, "reportedAt": "<ISO>",
       "status": "in-progress", "summary": "...", "percentComplete": 50,
       "checkpoints": [{"at":"<ISO>","sessionId":"<id>","description":"..."}] }
     ```
   - On completion: set `status: "completed"` in progress.json, update queue.json
   - When spawning each team member, instructs them to write a self-note on node completion
     (see below)
6. **Team member self-notes**: every non-leader being, when their assigned node/subtask
   finishes, writes `world/beings/{id}/memory/self-notes/<ISO>.json` — free-form, captures
   what they did, decisions made, and anything worth remembering. The leader passes this
   instruction when spawning each member.
7. Human can read `world/tasks/{id}/progress.json` anytime without interrupting the runner
8. `npm run progress -- <taskId>` shows a formatted summary

### Human Meetup + Freeze

Meetup is the **only hard interrupt** in the system. Unlike the shift clock (soft
signals only), meetup calls `AbortController.abort()` on the target runner(s).
Use it for conversational or local-file tasks where interruption is safe. For sandbox
tasks (open ports, running processes), prefer the soft `/msg` injection instead.

**Global meetup** — freeze all runners:
```bash
npm run meetup
```
All `TaskRunner` instances are hard-aborted. Sessions are already persisted
(written on every init message), so resume is instant. Type in the world terminal;
type `/done` to resume all.

**Task-level meetup** — freeze only one World Task:
```bash
npm run meetup -- --task <taskId>
```
Only that World Task's `TaskRunner` is hard-aborted. All other World Tasks (other
`TaskRunner` instances) keep running uninterrupted.

> "tasks" here always means **World Tasks** (entries in `queue.json`, one `TaskRunner`
> each). Sub-tasks are ephemeral `Task` tool calls inside the leader's context — they
> have no separate session and cannot be individually targeted.

Communicate via: `/msg --task <id> <message>` in the world terminal.
Type `/done` to resume that runner.

**Soft message injection** (non-interrupting alternative):
```
/msg --task <id> <message>
```
Injects a message into the runner's `pendingMessages` queue. The leader sees it on
the next `query()` resume and can adjust direction without stopping.

**Session persistence and sub-task state on hard-abort:**

Only one session ID is persisted per World Task — the Orchestrator's top-level
`query()` session, written to `world/sessions/tasks/{taskId}.json` on every
`system/init` message:

```
TaskRunner.query()  ← session ID saved here  ✅
    └─ Task → Leader   ← no session saved    ❌  (ephemeral)
          ├─ Task → Being A                  ❌  (ephemeral)
          └─ Task → Being B                  ❌  (ephemeral)
```

When `AbortController.abort()` fires, all in-flight `Task` calls (Leader, Being A,
Being B) are terminated immediately. Any work they had not yet written to disk is lost.

**The only durable state is what the leader wrote to `progress.json` before the abort.**
This is why the leader is instructed to write checkpoints at meaningful stopping points —
not for the shift clock, but as the recovery anchor for hard-abort resume.

**Resume-from-checkpoint**: on resume, the runner re-enters `query()` with
the saved Orchestrator session ID (`isResume: true`). The prompt instructs the
Orchestrator to re-spawn the leader and tell it: *"read `progress.json`, find the
latest checkpoint, continue from there."* The leader starts as a fresh subagent
instance with no memory of mid-task state — only what was written to `progress.json`.

### Being-Created Tools + Sync Daemon

**This is the self-evolution mechanism.** After completing a World Task, beings are
encouraged to look back and ask: *"What did I do repeatedly? What knowledge should
exist for the next being who faces a similar problem?"* The answer becomes a skill or
tool — created by the being, shared with the world.

- Beings write tools (TypeScript MCP functions) to `world/beings/{id}/tools/` (private)
- Beings write skills (`.md` guidance files) to `world/beings/{id}/skills/` (private)
- To share with the whole world: move to `world/shared/tools/` or `world/shared/skills/`
- Sync daemon promotes shared tools → `src/tools/generated/` and skills → `.claude/skills/`
- Sync is **opt-in** by the being — nothing is auto-promoted; sharing is a deliberate act

Over time, the world accumulates institutional knowledge that no single being had at
the start. Tasks get easier. Beings build on each other's work. The world compounds.

> *This automation is planned (Phase 6), not yet running. But the intent shapes how
> beings are instructed today: after every task, reflect and contribute.*

### Escalation
- `report` MCP tool: writes to `world/reports/escalations.json` + stdout marker `[ESCALATION]`
- Beings self-escalate when: blocked, uncertain, task requires human decision
- Orchestrator escalates when: beings pool saturated, conflicting tasks detected

### Concurrency Control

Each task can carry a `maxBeings` field. This is the **total number of distinct beings**
the Leader may use across the entire task lifetime (including itself). The same being
can be re-called multiple times without counting again. It is a prompt-level constraint,
not a code-enforced concurrency cap.

Use it to control total LLM cost or to match model rate limits:

```bash
# No limit — Leader uses its own judgement
npm run task -- "Brainstorm blog topics for Q2"

# Only 1 being total — Leader works alone, no team members
npm run task -- "Detailed competitor analysis" --max-beings 1

# Up to 2 distinct beings (leader + 1 other)
npm run task -- "Write and review a blog post" --max-beings 2
```

The limit is stored on the task in `world/tasks/queue.json` and surfaced in the
Orchestrator prompt when the task is assigned:

```
• [HIGH] a1b2c3d4 — Detailed competitor analysis [MAX BEINGS: 1 — leader works alone]
```

The world-level `npm start` has no concurrency flag — limits are set per task, not per world.

### Error Recovery

**Runner crash**: if a TaskRunner's `query()` throws a non-abort error, the runner marks
itself `failed` and is removed from the active registry. Its session is already persisted —
the scheduler will detect the `in-progress` task without a runner on the next tick and
recover it automatically.

**Crash recovery on startup**: the engine scans `world/tasks/queue.json` for any
`in-progress` tasks and creates `TaskRunner` instances for them before the first scheduler
tick. They resume from the saved session in `world/sessions/tasks/{id}.json`.

**Orphaned tasks**: tasks stuck `in-progress` with no session file are restarted fresh
(treated as first run).

## Implementation Phases

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Project foundation + folder skeleton | done |
| 1 | Multi-horizon memory store (`src/memory/`) | done |
| 2 | Shift clock (`src/scheduler/clock.ts`) — 10-min MVP | done |
| 3 | Dynamic being pool (starts at zero) + Orchestrator | done |
| 4 | Human meetup + freeze (global + task-level) | done |
| 5 | Parallel task execution — `TaskRunner` + leader + progress checkpoints | done |
| 6 | Being-created tools/skills + sync daemon | planned |
| 7 | Built-in MCP tools (HN, Reddit, ingest, report) | planned |
| 8 | FeatBit domain knowledge + content pipeline | planned |
