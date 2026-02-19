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

This runs the Orchestrator in an infinite loop. The world keeps running until you stop it (`Ctrl+C`).
Keep this terminal open — all being activity and `[ESCALATION]` markers print here.

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

The task lands in `world/tasks/queue.json`. The Orchestrator picks it up on its next
turn — the world does not respond immediately.

Options:
| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--priority` | `low` `normal` `high` `critical` | `normal` | Task urgency |
| `--plan` | — | off | Require plan approval from human before execution |
| `--max-beings` | `1`, `2`, `3`… | unlimited | Max beings the Orchestrator may activate for this task. Use `1` or `2` to limit concurrent LLM calls when your model has rate/concurrency constraints. |

### Schedule a meetup (freeze + talk)

```bash
npm run meetup
```

Sends a freeze signal. On its next turn, the Orchestrator suspends all beings (they
each write a state snapshot). Switch to the `npm start` terminal and type freely — the
Orchestrator will see your messages. When finished:

```
/done
```

Beings resume from exactly where they stopped.

You can also inject commands inline during a meetup or at any time in the world terminal:

| Input | Effect |
|-------|--------|
| `/done` or `/resume` | End meetup, resume all beings |
| `/task <description>` | Add a task directly from the world terminal |
| Any other text | Queued as a human message to the Orchestrator |

### Check escalations

Beings escalate to you by writing to `world/reports/escalations.json` and printing
`[ESCALATION]` markers in the world terminal. Review with:

```bash
Get-Content world/reports/escalations.json | ConvertFrom-Json   # PowerShell
cat world/reports/escalations.json                              # bash/zsh
```



## How the World Runs

The world runs on a continuous clock. Each "day" is a fixed time window.
MVP cadence: **8 minutes work + 2 minutes rest = 10 minutes per day**.

At rest time:
- Every being writes a shift summary of what it did and what it learned
- The world updates its daily memory record

At the end of each day:
- Daily records roll up into weekly and monthly summaries
- Escalations (things requiring human attention) are flushed to `world/reports/`

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

`npm run meetup` triggers a world freeze. All beings complete their current
atomic action, write a state snapshot, and go idle. You communicate with the
Orchestrator in the terminal. Type `/done` and work resumes from exactly where it stopped.

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
