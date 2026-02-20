# Vibe Guild

An autonomous AI world that works for FeatBit's vibe marketing — continuously,
without being told what to do next. The human operator stays in control: add tasks,
monitor progress, and intervene via meetup at any point to redirect work, add team
members, or inject new requirements.

## What It Does

Vibe Guild is a team of AI beings that monitor trends, analyze content, and produce
marketing insights and blog posts for FeatBit. You give the world a task. The beings
form teams, divide the work, execute, and report back to you.

## Quick Start

```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY (and optionally ANTHROPIC_BASE_URL / ANTHROPIC_MODEL_ID)
npm start              # start the world — runs continuously
```

## Human Operator Commands

All commands load `.env` automatically. The world runs in its own terminal (`npm start`);
everything else is issued from a second terminal.

### Start the world

```bash
npm start
```

This starts the world scheduler (ticks every 5 s). The scheduler:
- Starts a parallel `TaskRunner` for every assigned task
- Runs a lightweight Orchestrator turn when pending tasks need assignment
- Handles rest/day-end and meetup signals without blocking running tasks

Keep this terminal open — all being and runner output prints here.

### Check world status

```bash
npm run status
```

Shows current day, task queue counts, and any unprocessed signals.

### Add a task

```bash
# Basic
npm run task -- "Discuss: top 3 ways FeatBit could grow its community this quarter"

# High priority
npm run task -- "Write a Twitter thread about feature flags for AI apps" --priority high

# Require plan approval before execution
npm run task -- "Research: what are competitors saying about progressive delivery" --plan

# Limit concurrent beings for this task (use when your model has rate limits)
npm run task -- "Summarise this week's HN posts about feature flags" --max-beings 1
npm run task -- "Write a blog post draft on progressive delivery" --max-beings 2
```

The task lands in `world/tasks/queue.json`. On the next scheduler tick (≤5 s), the
Orchestrator assigns it (picking a leader + team), then the engine starts a dedicated
`TaskRunner` for it. Multiple tasks run in parallel — each has its own session.

Options:
| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--priority` | `low` `normal` `high` `critical` | `normal` | Task urgency |
| `--plan` | — | off | Require plan approval from human before execution |
| `--max-beings` | `1`, `2`, `3`… | unlimited | Total number of *distinct* beings the Leader may use across the whole task (including itself). The same being can be re-called multiple times without counting again. Use `1` to have the leader work alone. |

### Check task progress

```bash
npm run progress -- <taskId>    # full or short (prefix) ID
```

Reads `world/tasks/{id}/progress.json` — written by the task leader at
self-decided checkpoints (leader reads `world/memory/world.json` first, so
each report includes `worldDay` + `reportedAt` for world-clock context).
Shows leader, world day, status, percent complete, summary, and checkpoints.

### Schedule a meetup (hard freeze + talk)

Meetup is a **hard interrupt** — it calls `AbortController.abort()` on the
target runner(s). Use it for conversational or local-file tasks where stopping
mid-turn is safe. For sandbox tasks running code or holding ports, use
`/msg --task` instead (soft injection, no abort).

**Global freeze — all runners pause:**
```bash
npm run meetup
```

Switch to the `npm start` terminal, type freely. When finished:

```
/done
```

All runners resume from exactly where they stopped (session IDs are persisted).

**Task-level freeze — pause only one task:**
```bash
npm run meetup -- --task <taskId>   # full or prefix ID
```

Only that task's runner pauses. Other tasks continue running uninterrupted.
In the world terminal: `/msg --task <id> <message>`, then `/done` to resume.

Terminal commands available at any time in the `npm start` window:

| Input | Effect |
|-------|--------|
| `/done` or `/resume` | End meetup (global or task), resume runner(s) |
| `/task <description>` | Add a task directly from the world terminal |
| `/msg --task <id> <message>` | Inject a message into a runner (soft, no abort — safe for sandbox tasks) |
| Any other text | Queued as a human message to the Orchestrator |

### Check escalations

Beings escalate to you by writing to `world/reports/escalations.json` and printing
`[ESCALATION]` markers in the world terminal. Review with:

```bash
Get-Content world/reports/escalations.json | ConvertFrom-Json   # PowerShell
cat world/reports/escalations.json                              # bash/zsh
```



## How the World Runs

The world runs on a 5-second scheduler loop. Each "day" is a fixed real-time window.
MVP cadence: **8 minutes work + 2 minutes rest = 10 minutes per day**.

Inside the scheduler each tick:
1. Drain signals (rest, day-end, meetup, task-added)
2. Start a `TaskRunner` for every newly assigned task — tasks run **in parallel**
3. Run a short Orchestrator turn only when there are pending tasks or human messages

Each `TaskRunner` owns an independent `query()` session. The session ID is persisted
to `world/sessions/tasks/{taskId}.json` on every init message, enabling seamless
resume after crashes or hard-abort meetups.

**Subagent tree — real parallel agents, not role-play:**
```
TaskRunner.query()         ← Orchestrator (independent Claude instance)
    └─ Task → Leader       ← real subagent, own context
          ├─ Task → Being A     ← can run in parallel with B
          └─ Task → Being B     ← result flows back to Leader only
```
Being A and B are separate Claude instances. A's result enters Leader's context;
B doesn't see it unless Leader passes it along. The Leader decides whether to run
members in parallel (independent subtasks) or serially (B needs A's output).
The same being can be called multiple times across rounds — each call is a fresh
instance. `--max-beings N` limits the total number of *distinct* beings the Leader
may use across the whole task (including itself).

We use the subagent tree instead of Claude Code's experimental Agent Teams because:
Agent Teams are unstable (no session resumption, known coordination bugs), do not
support nested team spawning, and store state in `~/.claude/` rather than `world/`.
The `Task` tool gives us the same real-parallelism without those constraints.

**The shift clock is soft — it never interrupts running tasks.** At rest time the
engine injects a message into each runner: *"at your next safe stopping point, write
a checkpoint and shift summary, then continue."* The leader decides when to pause
between tool calls. This makes the system safe for tasks that hold open ports, run
in sandboxes, or do multi-step code execution.

At the end of each day the engine reads all observable state (progress files, shift
files already written, escalations) and writes `world/memory/daily/{date}.json`.
Runners keep going — the clock is a logging cadence, not a work cycle controller.

**The only hard interrupt** is `npm run meetup (global or `--task <id>`), which calls
`AbortController.abort()` and resumes from the last session checkpoint. Use it for
conversational or local-file tasks. For sandbox tasks, prefer `/msg --task <id>` to
inject direction without aborting.

## Project Structure

| Folder | Owner | Purpose |
|--------|-------|---------|
| `src/` | You | World Engine — TypeScript code that runs the world |
| `.claude/` | You | World Law — CLAUDE.md, skills, and being definitions |
| `world/` | Beings | The Living World — memory, tasks, tools beings create |
| `output/` | Beings | Deliverables — blog drafts, insights, reports |

The key distinction: `src/` and `.claude/` are the laws of the world (you write them).
`world/` is the living world (beings write it).

## World Mechanics

### Beings

Beings are defined in `.claude/agents/{id}.md` and tracked in `world/beings/{id}/profile.json`.
The pool starts empty and grows entirely on demand — no fixed roster, no upper limit.

**Assignment strategy (enforced every turn):**
1. Free existing beings are assigned first.
2. If a task needs more capacity than is currently free, the Orchestrator creates new beings on demand.
3. Each being may only work on **one task at a time** — the engine tracks occupancy via `getBusyBeings()` and surfaces it in every Orchestrator prompt.

**Creating a new being (done by the Orchestrator, not by you):**
1. Read `.claude/agents/_template.md`, fill in the role placeholders, save as `.claude/agents/{name}.md`.
2. Write `world/beings/{name}/profile.json` with `id`, `name`, `role`, `description`, `skills[]`, `status: "idle"`, `createdAt`.
3. The engine auto-scaffolds `memory/shifts/`, `memory/self-notes/`, `skills/`, `tools/` on the next turn.

Demonstrated history — stored in `world/beings/{id}/profile.json` — shapes which
being gets assigned to which task. Beings evolve as they accumulate experience.

### Memory

Memory is layered across multiple time horizons:

- **Being memory**: private shift summaries + self-notes the being decides to write
- **Team memory**: shared decisions, blockers, objectives per team
- **Project memory**: cross-task context for ongoing projects
- **Daily / weekly / monthly**: automated rollups
- **World record**: cumulative history of everything ever done

Beings write their own self-notes freely — the system does not constrain what they
consider worth remembering.

### Team Formation

When a task arrives, the Orchestrator picks idle beings (creating new ones from
`_template.md` if needed), elects a leader, and writes the assignment to
`world/tasks/queue.json`. The scheduler detects the newly assigned task and starts
a `TaskRunner`. Inside the runner, the Orchestrator spawns the leader via the `Task`
tool; the leader then coordinates the team using further `Task` tool calls.
See the Subagent Execution Model section in WORLD-DESIGN.md for the full execution tree.

### Human Meetup

Meetup is the **only hard interrupt** — it calls `AbortController.abort()` on World Task
runner(s). "Tasks" here always means **World Tasks** (one per `queue.json` entry, one
`TaskRunner`). Sub-tasks are ephemeral `Task` tool calls inside the leader's context —
they have no persistent session and are terminated together with their World Task runner.

Safe for conversational or local-file tasks. For sandbox tasks (open ports, running
processes), use `/msg --task <id>` soft injection instead (no abort).

`npm run meetup` — **global** freeze: all World Task runners pause, communicate freely
in the world terminal, `/done` resumes all.

`npm run meetup -- --task <id>` — **task-level** freeze: only that World Task's runner
pauses; other World Tasks keep running. `/msg --task <id> <message>` injects a message
without aborting; `/done` resumes the paused runner.

**Redirecting a task mid-run** — inject a message before `/done`:
```
/msg --task a1b2c3d4 Add being 'bram' to do a Chinese localization pass on the draft
/done
```
The leader receives the message on resume, writes a checkpoint, acknowledges, then acts:
spawning new beings, adding steps, changing scope — whatever the instruction says.
The human can add beings, insert steps, change priority, or stop the task early.

Global messages (typed without `/msg --task`) go to the global Orchestrator's assignment
turn — useful for adding new tasks or changing world-level priorities.

**On resume**, the runner re-enters `query()` with the World Task session ID saved in
`world/sessions/tasks/{taskId}.json`. The leader is re-spawned as a fresh instance and
reads `progress.json` to recover state. Any sub-task work not written to `progress.json`
before the abort is lost — this is why the leader writes checkpoints at meaningful points.

### Being-Created Tools and Skills

This is the **self-evolution mechanism** — the core philosophy of Vibe Guild.

After completing a World Task, beings are encouraged to reflect: *"What did I do
repeatedly? What knowledge should exist for the next being who faces a similar
problem?"* The answer becomes a skill or tool — created by the being, shared with
the world.

Beings write tools (TypeScript MCP functions) and skills (`.md` files) into their own
`world/beings/{id}/tools/` and `world/beings/{id}/skills/` folders. When a being
decides something is useful for everyone, it moves it to `world/shared/`. A sync
daemon watches `world/shared/` and promotes tools to `src/tools/generated/` and skills
to `.claude/skills/`, making them available to the whole world engine.

Over time the world accumulates institutional knowledge that no single being had at
the start. Tasks get easier. Beings build on each other's work. The world compounds.

> This automation is planned (Phase 6), not yet running. But the intent shapes how
> beings are instructed today: after every task, reflect and contribute.

## Stack

- [Claude Agent SDK](https://code.claude.com/docs/en/sdk) (`@anthropic-ai/claude-agent-sdk`) — `query()` loop, `Task` tool (subagent tree), MCP, session resumption
- TypeScript with ESM (`import`, never `require`)
- `node-cron` — shift clock
- `chokidar` — sync daemon (Phase 6)

See [WORLD-DESIGN.md](WORLD-DESIGN.md) for the full architecture reference.
