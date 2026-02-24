# Vibe Guild

An autonomous AI world that works for FeatBit's vibe marketing — continuously,
without being told what to do next. The human operator stays in control: add tasks,
monitor progress, and intervene via meetup at any point to redirect work, add team
members, or inject new requirements.

## What It Does

Vibe Guild is a world-level orchestrator for AI work. You give the world a task, and it
coordinates the right runtime for execution:

- content and research tasks (web browsing, deep research, analysis),
- coding tasks (implement, test, debug, fix),
- mixed tasks that depend on outputs from previous world tasks.

Every world task reports back to `world/` in creator-friendly form, while deeper
execution details can live in the task's GitHub repository.

## Quick Start

```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY (and optionally ANTHROPIC_BASE_URL / ANTHROPIC_MODEL_ID)
npm start              # start the world — runs continuously
```

For `RUNTIME_MODE=docker`, `VIBEGUILD_GITHUB_TOKEN` is required. Every task must create a GitHub repo;
if repo creation fails, the task is marked `failed`.

Repo lifecycle (Docker mode):
- Repo resolution is owned by sandbox entrypoint (not host orchestrator).
- Naming rule: `task-<normalized-task-title>-<taskId8>` (readable + deterministic).
- Reuse rule: exact-name match first (resume same task), then latest repo with same title prefix,
  then create new (org first, user fallback).

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
- Handles world cadence and meetup signals without blocking running tasks

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
npm run vg -- progress <taskId-or-prefix>
```

Reads `world/tasks/{id}/progress.json` — a creator-facing summary synchronized from
the running task runtime. Shows status, progress, summary, latest checkpoints, and
other intervention-ready context.

### Schedule a meetup (hard freeze + talk)

Meetup is a **hard interrupt** at world-task level. Use it for conversational or
local-file tasks where stopping mid-turn is safe. For sandbox tasks running code or holding ports, use
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

### Creator Console (`vg`) — compact CLI for low-token world visibility

Use `vg` when you want quick, human-readable snapshots in the terminal (or via Copilot)
without reading multiple JSON files. Works on both Windows (PowerShell) and macOS/Linux.

**PowerShell (Windows):**
```powershell
# from repo root
node scripts/vg.mjs overview

# list tasks (all / by status)
node scripts/vg.mjs tasks
node scripts/vg.mjs tasks pending
node scripts/vg.mjs tasks assigned 30

# inspect one task by full ID or prefix
node scripts/vg.mjs progress <taskId-or-prefix>

# recent escalations
node scripts/vg.mjs escalations
```

Or via npm (works on all platforms):
```bash
npm run vg -- overview
npm run vg -- tasks pending
npm run vg -- progress <taskId-or-prefix>
npm run vg -- escalations
```

**bash (macOS / Linux / WSL):**
```bash
bash scripts/vg overview
bash scripts/vg tasks pending
bash scripts/vg progress <taskId-or-prefix>
bash scripts/vg escalations
```

What each command shows:

- `overview`: world day/status, beings, task status distribution, escalation count
- `tasks [status] [limit]`: compact rows: short ID, status, priority, leader, title
- `progress <id|prefix>`: leader/status/percent/summary/latest checkpoint for one task
- `escalations [limit]`: latest escalation entries in chronological order

This is intentionally read-only and safe for daily operator visibility.



## Architecture Snapshot

Vibe Guild uses a two-plane model:

1. **Control Plane (host process)**
   - assignment, scheduling, intervention, escalation,
   - AI beings as persistent cognitive layer (planning, collaboration, memory),
   - writes creator-facing world state (`world/`),
   - `chokidar` watches `world/tasks/*/progress.json` → fires `onProgress` → creator console,
   - `/msg --task <id>` writes `inbox.json` → sandbox reads and course-corrects.

2. **Execution Plane (Docker sandbox — one container per world task, multiple tasks run in parallel)**

   **v1 — Single session (current ✅)**
   One `claude` CLI process. The leader drives the full task — members exist as named
   roles in the prompt. The leader acts, writes progress, and records self-notes for
   all members at task end.

   **v2 — Leader + subagents (planned 🧪)**
   Leader session uses Claude Code's built-in `Task` tool to spawn each member as an
   independent subagent inside the same container, sharing the same volume mounts.
   *(Not yet started — key unknown: whether GLM-5 reliably invokes `Task` tool.)*

Dual state model:

- **Execution truth**: GitHub commits, `output/` deliverables — deep technical detail.
- **World truth**: `world/` progress + memory — creator-facing, intervention-ready.

Runtime logs are persisted per task under `world/tasks/{id}/logs/` (for example
`runtime.log`, `claude-code.log`, `docker.log`, `progress-events.ndjson`) and can be
mirrored into task repos under `runtime-details/{taskId}/`.

Compatibility guard (Docker runtime): if Claude exits `0` with empty stdout/stderr while
`--mcp-config` is enabled, sandbox retries once without MCP config (still Claude CLI).
This avoids silent no-op runs on some Anthropic-compatible endpoints.

Sandbox isolation via precise Docker volume mounts (not prompt constraints):

| Mount | Mode | Purpose |
|-------|------|---------|
| `world/tasks/{id}/` | rw | progress, inbox |
| `world/beings/{id}/` ×N | rw | memory, profile, skills |
| `output/` | rw | deliverables |
| `world/memory/world.json` | ro | read dayCount |
| `AGENTS.md` | ro | world rules |
| `src/sandbox/entrypoint.mjs` | ro | entrypoint only |

## Current Transition Status

The architecture target above is now the official design baseline.

- `WORLD-DESIGN.md` defines the canonical model.
- `README.md` focuses on operator workflows and commands.
- Runtime adapter and sandbox execution plumbing are implemented incrementally.

## Project Structure

| Folder | Owner | Purpose |
|--------|-------|---------|
| `src/` | You | World Engine and orchestration runtime |
| `.claude/` | You | World law, agent definitions, skills |
| `world/` | Runtime + Beings | Creator-facing state, memory, tasks, reports |
| `output/` | Beings | Deliverables — drafts, reports, artifacts |

Key rule:

- The creator should be able to operate from `world/` + `vg` without reading low-level runtime files.
- Deep execution details remain available in task runtime repos/artifacts when needed.

## Stack

- [Claude Agent SDK](https://code.claude.com/docs/en/sdk) (`@anthropic-ai/claude-agent-sdk`) — orchestration and intervention flow
- `claude` CLI — runs inside Docker sandbox as the execution agent
- TypeScript with ESM (`import`, never `require`)
- `chokidar` — watches `progress.json` for real-time creator console updates
- Docker — one container per world task, precise volume mount isolation
- sandbox runtime adapter (`local` SDK mode or `docker` mode, switched via `RUNTIME_MODE`)

See [WORLD-DESIGN.md](WORLD-DESIGN.md) for the full architecture reference.
