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
    ├── tasks/            shared task list (queue.json)
    ├── sessions/         orchestrator.json — session ID for resumption
    └── reports/          escalations.json, meetup notes
```

## World Mechanics

### Shift Clock (MVP: 10-min day)
- 8 minutes work → 2 minutes rest → repeat
- Rest period: every being writes shift summary to `world/beings/{id}/memory/shifts/`
- Day end: daily record written to `world/memory/daily/`, world state incremented
- Production cadence: 25 min work + 5 min rest (30-min day)

### Memory Hierarchy
- **Being memory**: private shift summaries + self-notes (being-initiated, not system-mandated)
- **Team memory**: `world/memory/team/{team-id}.json` — shared decisions, blockers, objectives
- **Project memory**: `world/memory/project/{id}.json` — cross-task context
- **Daily/weekly/monthly**: automated rollups; weekly = summary of 7 daily records
- **World record**: `world/memory/world.json` — cumulative history, completed projects

### Being Pool (30 beings)
- Defined in `.claude/agents/{id}.md` (filesystem agent format — loaded automatically)
- All broadly capable; demonstrated history shapes assignment priority
- Only beings with active tasks spin up as live teammates (token cost control)
- After each task cycle, Orchestrator updates the being's `.md` description with new skills

### Team Formation + Leader Election
1. Orchestrator broadcasts task to idle beings via Agent Teams Mailbox
2. Beings discuss, propose team structure, nominate a leader
3. Orchestrator formalizes: writes `world/memory/team/{id}.json`, updates being profiles
4. Leader gets plan-approval authority for their team scope

### Human Meetup + Freeze
- Scheduled (cron) or on-demand: `tsx src/world.ts meetup`
- All beings complete current atomic action → freeze state snapshot → go idle
- Human communicates with Orchestrator via terminal input loop
- `/done` → Orchestrator broadcasts resume → beings reload freeze snapshot

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

### Error Recovery (Retry + Backoff)

Every world turn is wrapped in a retry loop with exponential backoff. Only errors that look like transient infrastructure failures trigger retries; logic errors are skipped immediately.

| Error type | Detection pattern | Behaviour |
|------------|-------------------|-----------|
| Timeout / rate limit / overload | `timeout`, `timed out`, `rate limit`, `overload`, `529`, `503`, `ECONNRESET`, `socket` | Retry up to 3 times with exponential backoff |
| Any other error | everything else | Skip turn immediately, no retry |

Backoff schedule (base delay 10 s):

| Attempt | Delay before retry |
|---------|--------------------|
| 1 → 2   | 10 s |
| 2 → 3   | 20 s |
| 3 → fail | 40 s then give up |

After exhausting retries (or for non-retryable errors), the engine logs the failure, waits 15 s, and moves on to the next world turn. The world never crashes — a bad turn is recorded and the clock keeps running.

## Implementation Phases

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Project foundation + folder skeleton | done |
| 1 | Multi-horizon memory store (`src/memory/`) | in progress |
| 2 | Shift clock (`src/scheduler/clock.ts`) — 10-min MVP | in progress |
| 3 | Being pool (`3` MVP beings) + Orchestrator (`src/world.ts`) | in progress |
| 4 | Human meetup + freeze mechanism | planned |
| 5 | Task system + team formation + leader election | planned |
| 6 | Being pool expansion to 30 | planned |
| 7 | Being-created tools/skills + sync daemon | planned |
| 8 | Built-in MCP tools (HN, Reddit, ingest, report) | planned |
| 9 | FeatBit domain knowledge + content pipeline | planned |
