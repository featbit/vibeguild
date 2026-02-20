# Vibe Guild

An autonomous AI world that works for FeatBit's vibe marketing — continuously,
without being told what to do next.

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
| `--max-beings` | `1`, `2`, `3`… | unlimited | Max beings the Orchestrator may activate for this task. Use `1` or `2` to limit concurrent LLM calls when your model has rate/concurrency constraints. |

### Check task progress

```bash
npm run progress -- <taskId>    # full or short (prefix) ID
```

Reads `world/tasks/{id}/progress.json` — written by the task leader after each
milestone. Shows leader, status, percent complete, summary, and checkpoints.

### Schedule a meetup (freeze + talk)

**Global freeze — all runners pause:**
```bash
npm run meetup
```

Switching to the `npm start` terminal, type freely. When finished:

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
| `/msg --task <id> <message>` | Send a message to a specific task runner |
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

Each `TaskRunner` owns an independent `query()` session. The session ID is written
to `world/sessions/tasks/{taskId}.json` on every init message, enabling seamless
resume after rest periods or crashes.

At rest time:
- All runners are paused (AbortController)
- Every being runs a parallel shift-summary turn (writes `world/beings/{id}/memory/shifts/`)
- The scheduler waits for day-end before resuming runners

At the end of each day:
- The engine writes `world/memory/daily/{date}.json`
- All paused runners resume from their last saved session checkpoint

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

When a large task arrives, the Orchestrator broadcasts it to idle beings. They discuss
via the Agent Teams Mailbox, propose a team structure, and elect a leader. The
Orchestrator formalizes the team (`world/memory/team/{id}.json`) and marks the leader.

### Human Meetup

`npm run meetup` triggers a **global** freeze — all runners pause, you communicate
with the Orchestrator, then `/done` resumes all.

`npm run meetup -- --task <id>` triggers a **task-level** freeze — only that
runner pauses. Other tasks keep running. Use `/msg --task <id> <message>` to send
guidance, then `/done` to resume that runner.

### Being-Created Tools and Skills

Beings write tools (TypeScript MCP functions) and skills (`.md` files) into their own
`world/beings/{id}/tools/` and `world/beings/{id}/skills/` folders. When a being
decides something is useful for everyone, it moves it to `world/shared/`. A sync
daemon watches `world/shared/` and promotes tools to `src/tools/generated/` and skills
to `.claude/skills/`, making them available to the whole world engine.

## Stack

- [Claude Agent SDK](https://code.claude.com/docs/en/sdk) (`@anthropic-ai/claude-agent-sdk`) — agent teams, MCP, session resumption
- TypeScript with ESM (`import`, never `require`)
- `node-cron` — shift clock
- `chokidar` — sync daemon (Phase 6)

See [WORLD-DESIGN.md](WORLD-DESIGN.md) for the full architecture reference.
