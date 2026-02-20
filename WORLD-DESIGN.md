# Vibe Guild — Architecture Summary

## What It Is

Vibe Guild is an autonomous AI world for FeatBit's vibe marketing. A pool of AI beings
work continuously, self-organize into teams, and report to a human operator. Their
primary mission: monitor trends, generate insights, and produce content around
feature flags, feature management, and AI coding.

## Tech Stack

- **Runtime**: `@anthropic-ai/claude-agent-sdk` `^0.2.47` (Claude Agent SDK, formerly Claude Code SDK)
- **Language**: TypeScript `^5.9.3` (ESM, `"type": "module"`, functional — no classes)
- **Agent Teams**: experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`)
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
    │       └── progress.json  leader writes after each milestone (+ checkpoints)
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
  2. MEETUP_FREEZE {taskId?} → pause one runner or all runners
  3. SHIFT_REST_START → pause all runners, run parallel shift summaries
  4. SHIFT_DAY_END    → write daily record, resume all paused runners
  5. newly assigned tasks not in registry → start new TaskRunner
  6. in-progress tasks not in registry (crash recovery) → resume TaskRunner
  7. pending tasks / human messages → short Orchestrator assignment turn
```

The Orchestrator is used **only for assignment** (short turns, `maxTurns: 10`).
Task execution is handled entirely by `TaskRunner` instances.

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

### Shift Clock (MVP: 10-min day)
- 8 minutes work → 2 minutes rest → repeat
- Rest period: all runners are paused; each being writes its own shift summary via a
  **parallel** `query()` (not a single blocking Orchestrator turn)
- Day end: daily record written to `world/memory/daily/`, all runners resume
- Production cadence: 25 min work + 5 min rest (30-min day)

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
   - Write `world/tasks/{id}/progress.json` after each milestone:
     ```json
     { "taskId": "...", "leaderId": "aria", "status": "in-progress",
       "summary": "...", "percentComplete": 50,
       "checkpoints": [{"at":"<ISO>","sessionId":"<id>","description":"..."}],
       "lastUpdated": "..." }
     ```
   - On completion: set `status: "completed"` in progress.json, update queue.json
6. Human can read `world/tasks/{id}/progress.json` anytime without interrupting the runner
7. `npm run progress -- <taskId>` shows a formatted summary

### Human Meetup + Freeze

**Global meetup** — freeze all runners:
```bash
npm run meetup
```
All `TaskRunner` instances are paused (AbortController.abort()). Sessions are already
persisted, so resume is instant. Type in the world terminal; type `/done` to resume all.

**Task-level meetup** — freeze only one runner:
```bash
npm run meetup -- --task <taskId>
```
Only the named runner is paused. All other tasks keep running.
Communicate via: `/msg --task <id> <message>` in the world terminal.
Type `/done` to resume that runner only.

**Resume-from-checkpoint**: on resume, the runner re-enters `query()` with the saved
session ID. The leader reads `world/tasks/{id}/progress.json` and continues from the
last written checkpoint — no work is lost.

### Being-Created Tools + Sync Daemon
- Beings write tools to `world/beings/{id}/tools/` (private)
- Sharing: move to `world/shared/tools/` → sync daemon copies to `src/tools/generated/`
- Skills (`.md` files): same pattern, sync target is `.claude/skills/`
- Sync is opt-in by the being — nothing is auto-promoted

### Escalation
- `report` MCP tool: writes to `world/reports/escalations.json` + stdout marker `[ESCALATION]`
- Beings self-escalate when: blocked, uncertain, task requires human decision
- Orchestrator escalates when: beings pool saturated, conflicting tasks detected

### Concurrency Control

Each task can carry a `maxBeings` field that caps how many beings the Orchestrator may
activate simultaneously for that task. This directly limits concurrent LLM calls and is
essential for models with rate or concurrency constraints (e.g. GLM code-plan tier).

```bash
# No limit — Orchestrator uses its own judgement
npm run task -- "Brainstorm blog topics for Q2"

# Cap at 1 being — fully sequential, one LLM call at a time
npm run task -- "Detailed competitor analysis" --max-beings 1

# Cap at 2 beings
npm run task -- "Write and review a blog post" --max-beings 2
```

The limit is stored on the task in `world/tasks/queue.json` and surfaced in the
Orchestrator prompt when the task is assigned:

```
• [HIGH] a1b2c3d4 — Detailed competitor analysis [MAX BEINGS: 1 — hard limit, sequence work rather than parallelise]
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
