# LP;HU — World Design (Current Baseline)

## Purpose

LP;HU is an always-on AI team execution system for FeatBit.

Its practical loop is:

- trigger demos from skills,
- validate skills through demo execution,
- generate best-practice outputs.

The system is human-in-the-loop first: autonomous execution is default, but operator intervention is always available.

---

## Core Principles

1. **Utility over polish**
   - Optimize for shipping useful outcomes now.
   - Avoid speculative architecture.

2. **Team, not single-agent roleplay**
   - Tasks are owned by an explicit AI team model.
   - Each role has one primary responsibility plus at least one secondary responsibility.

3. **Execution truth is local workspace**
  - Persistence anchor is category folders under `world/` (for example `world/demos/`, `world/examples/`, `world/insights/`).
  - Task metadata stores a pointer path (`sandboxWorkspacePath`) to the actual workspace location.
   - No per-task GitHub repo dependency in baseline runtime.

4. **Operator sovereignty**
   - Pause, inject, revise, resume at any time.
   - Alignment history is durable and queryable.

5. **Compatibility-first evolution**
   - Keep existing queue/progress contracts usable while adding richer semantics.

---

## Team Model (T-shaped)

Default team is persisted at `world/teams/active.json`.

Roles:

- `TeamLead`
  - Primary: planning integration, trade-off decisions, final direction.
  - Secondary: unblock any role when needed.
- `Builder`
  - Primary: implementation and task delivery.
  - Secondary: assist verification and demo wiring.
- `Verifier`
  - Primary: validation, test strategy, quality gates.
  - Secondary: risk notes and rollback guidance.
- `NarrativeEngineer`
  - Primary: developer narrative, blog/case writing, explainability.
  - Secondary: convert implementation artifacts into reusable teaching assets.
- `OperatorLiaison`
  - Primary: alignment protocol, summaries, decision-ready reporting.
  - Secondary: maintain continuity across revisions and escalations.

Design intent: focused ownership without isolated silos.

---

## Task Model

### Runtime status (control-plane)

- `pending`
- `assigned`
- `in-progress`
- `blocked`
- `completed`
- `failed`
- `escalated`

### Delivery semantic status (`completionLevel`)

- `not_started`
- `in_progress`
- `temp_done`
- `fully_done`

### Task taxonomy (`taskKind`)

- `demo`
- `dev_insight_blog`
- `learning_note`
- `issue_feedback`
- `skill_validation`
- `skill_demo_trigger`

---

## Runtime Architecture

### Control Plane (host)

Responsibilities:

- scheduler tick loop (every 5 s),
- task lifecycle transitions,
- runner start/monitor/recovery,
- signal dispatch and cron scheduling.

**Operator interface — three modes:**

| Mode | How | Best for |
|------|-----|----------|
| **Docker sandbox** | `npm start` → scheduler auto-starts containers | Long-running, isolated, automated |
| **Copilot Background** | `copilot` CLI (local background session) | Interactive, real-time collab |
| **Copilot Cloud** | `/delegate` inside Copilot CLI | Async, tangential, creates a PR |
- Copilot CLI command intake,
- Copilot SDK command execution,
- human alignment orchestration,
- world memory synchronization.

Key files:

- `src/world.ts`
- `src/tasks/queue.ts`
- `src/tasks/runner.ts`

### Execution Plane (docker)

One task = one container.

Mounted task workspace:

- host: `world/{demos|examples|insights}/<taskFolder>/`
- container: `/workspace/task-workspace`

Other mounts keep task isolation and world sync contracts.

Key files:

- `src/runtime/docker.ts`
- `src/sandbox/entrypoint.mjs`

---

## Data Layout

### Operator-facing state

- `world/tasks/queue.json` — task registry and lifecycle
- `world/tasks/<taskId>/progress.json` — latest execution snapshot + checkpoints
- `world/alignment/<taskId>/history.ndjson` — durable HITL conversation events
- `world/teams/active.json` — current team manifest
- `world/reports/escalations.json` — escalations
- `world/memory/world.json` — world metadata

### Task execution state

- `world/demos/<taskFolder>/` — demo-focused task workspaces
- `world/examples/<taskFolder>/` — validation/example task workspaces
- `world/insights/<taskFolder>/` — insight and narrative task workspaces
- `world/workspaces/<taskFolder>/` — fallback workspace bucket
- `world/tasks/<taskId>/logs/` — runtime and diagnostic logs
- `output/<taskId>/` — task deliverables

---

## Human Alignment Protocol

Alignment is event-driven and persisted.

Flow:

1. **Mandatory preflight**: before any implementation work, agent must publish a plan and set `status=waiting_for_human` in `progress.json`.
2. Operator reviews and replies with feedback or proceed instruction via terminal/Copilot CLI.
3. If feedback is provided, agent revises plan and asks again (`waiting_for_human`) until approved.
4. Each turn is appended to `world/alignment/<taskId>/history.ndjson`.
5. Only after explicit proceed instruction does active execution start.
6. During execution, additional `waiting_for_human` checkpoints may still be raised as needed.

Stored actors:

- `agent`
- `operator`
- `system`

Stored event kinds:

- `pause_request`
- `question`
- `reply`
- `resume`
- `status`

---

## Control Surface

LP;HU is Copilot-Chat-first:

- **Read state**: `node scripts/vg.mjs overview|tasks|progress|escalations`
- **Write/control**: `node scripts/vg-write.mjs add-task|inject-message|pause-task|resume|revise`
- task coordination and alignment are persisted in `world/tasks/{id}/` files,
- no Discord transport required; no stdin command parser.

**Skills and MCP** live in standard host locations (`~/.claude/`, `~/.agent/`, `~/.copilot/`):
- Copilot CLI reads them natively.
- Docker sandbox mounts them read-only via `FEATBIT_SKILLS_HOST_PATH` / `AGENT_HOME_HOST_PATH` env vars.

---

## Cron Model (Retained, Narrowed Scope)

`world/crons/` remains useful for periodic automation only:

- scheduled trend scans,
- recurring maintenance checks,
- weekly/monthly summaries,
- recurring validation runs.

Cron is not the primary vehicle for high-touch alignment-heavy workflows.

---

## Non-Goals

- Mandatory per-task GitHub repository creation.
- Role explosion into disconnected specialist silos.
- Replacing operator judgment with opaque full autonomy.

---

## Migration Notes (from previous baseline)

- Repo-first execution assumptions are removed from runtime baseline.
- Legacy Discord queued-command bridge (`scripts/vg-cmd.mjs`) is removed.
- Runtime no longer depends on Discord thread repo-url updates for task progress reporting.
- `src/discord.ts` deleted entirely. All notification calls replaced with direct `console.log`.
- `processLine()` stdin command parser deleted (~400 lines legacy). Operator control is now via
  `scripts/vg.mjs` (read) and `scripts/vg-write.mjs` (write) — called by Copilot Chat.
- `scripts/vg-write.mjs` added: `add-task`, `inject-message`, `pause-task`, `resume`, `revise`.
- Docker sandbox skills paths are now configurable via `FEATBIT_SKILLS_HOST_PATH` and
  `AGENT_HOME_HOST_PATH` env vars (defaults to `$HOME/.claude/…` and `$HOME/.agent`).
- `sandboxRepoUrl` added as an optional typed field to `SyncedProgress` and `Task`.
- Workspace-first persistence is canonical.
- Team roles moved to T-shaped model.
- Progress carries semantic completion level, workspace path, and sandbox repo URL.
- Alignment memory is persistent by default.
