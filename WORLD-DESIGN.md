# Vibe Guild — Architecture Summary

## What It Is

Vibe Guild is an autonomous world orchestrator for FeatBit. It accepts world tasks,
coordinates execution runtimes, and keeps the creator in control with real-time
visibility and intervention.

At its core, Vibe Guild is still a world of **AI beings**: beings own intent
interpretation, planning, collaboration, prioritization, reflection, and escalation.
Sandbox runtimes and task-scoped agents exist to execute work safely and reproducibly,
not to replace world beings as the cognitive center.

The system supports:
- content and research tasks,
- coding and debugging tasks,
- multi-step tasks that depend on outputs from prior world tasks.

## Core Design Principles

1. **Creator sovereignty first**
   - The creator can pause, resume, and inject instructions at any time.
   - Operator visibility must not depend on reading low-level execution files.

2. **Two-plane architecture**
   - **Control Plane (Host):** orchestration, assignment, world memory, intervention.
   - **Execution Plane (Sandbox):** task-scoped runtime where coding/research agents run.

3. **Dual truth model (non-conflicting)**
   - **Execution truth:** GitHub repo + runtime artifacts (detailed technical trace).
     The GitHub repo is the **primary persistent workspace** — all intermediate and
     final results must be committed there continuously. The repo survives Docker
     restarts and is the anchor for resuming or continuing tasks.
   - **World truth:** `world/` summaries and metadata (operator-facing).

4. **Cross-task continuity**
   - Later tasks may build on completed tasks through world/project metadata.
   - Shared context is carried through `world/memory/project/` and task metadata.

5. **Beings as the cognitive layer**
   - World beings are the persistent identity layer (role, memory, responsibility).
   - Sandbox/task agents are runtime incarnations of the same assigned world beings.
   - The world evolves through beings' memory and shared skills, not only through repos.

6. **Capability evolution loop**
   - A being may enter a task with prior experience from earlier world tasks, or be newly created.
   - During execution, beings produce deliverables (GitHub commits, output/ files) and
     write self-notes + skill files directly into `world/beings/{id}/`.

## Runtime Model

### High-Level Architecture (ASCII)

```text
                    +------------------------------------+
                    |     Creator / Operator Console     |
                    |  (vg CLI · meetup · inject msg)    |
                    +------------------+-----------------+
                                       |
                                       v
+--------------------------------------------------------------------------+
|                     Control Plane  (Host Process)                        |
|                                                                          |
|   Orchestrator (SDK)              Scheduler (5 s tick)                  |
|   · create / assign beings        · start runners for assigned tasks    |
|   · write queue.json              · detect completed / failed runners   |
|   · world memory decisions        · drain signals (meetup, inject…)     |
|                                                                          |
|   chokidar ──────── watches world/tasks/*/progress.json ──────────────► |
|                     fires onProgress → creator console                  |
|                                                  │                       |
|   creator console ──── /msg --task <id> <text> ──►  inbox.json (rw)  ──►|
|                     inject message mid-execution    sandbox reads next  |
+──────────────────────────────┬───────────────────────────────────────────+
                               │  one sandbox per world task
                               │  (multiple tasks → multiple sandboxes run in parallel)
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
   +─────────────────+ +─────────────────+ +─────────────────+
   │ Sandbox task A  │ │ Sandbox task B  │ │ Sandbox task C  │  (Docker containers)
   │                 │ │                 │ │                 │
   │  claude CLI     │ │  claude CLI     │ │  claude CLI     │
   │  (one process)  │ │  (one process)  │ │  (one process)  │
   │                 │ │                 │ │                 │
   │  leader drives  │ │  leader drives  │ │  leader drives  │
   │  full team in   │ │  full team in   │ │  full team in   │
   │  one session    │ │  one session    │ │  one session    │
   │                 │ │                 │ │                 │
   │  Mounts (rw):   │ │  Mounts (rw):   │ │  Mounts (rw):   │
   │  tasks/{id}/    │ │  tasks/{id}/    │ │  tasks/{id}/    │
   │  beings/{id}/×N │ │  beings/{id}/×N │ │  beings/{id}/×N │
   │  output/        │ │  output/        │ │  output/        │
   │  Mounts (ro):   │ │  Mounts (ro):   │ │  Mounts (ro):   │
   │  world.json     │ │  world.json     │ │  world.json     │
   │  AGENTS.md      │ │  AGENTS.md      │ │  AGENTS.md      │
   │  entrypoint.mjs │ │  entrypoint.mjs │ │  entrypoint.mjs │
   +────────┬────────+ +────────┬────────+ +────────┬────────+
            │                   │                   │
            └───────────────────┴───────────────────┘
                                │
                                ▼
                    +────────────────────────+
                    │   GitHub / External    │
                    │   APIs & Repos         │
                    +────────────────────────+
```

### Control Plane (Host)

The host orchestrator is responsible for:
- queue assignment and team/leader selection,
- world task lifecycle state,
- escalation handling,
- creator meetup and live intervention,
- syncing task summaries into `world/`.

**Discord fast-path (auto-assign bypass):** When a task is created via Discord (`/task`
in `drainDiscordPendingCmds`), the system directly picks a free being and sets the task to
`assigned` without waiting for an orchestrator AI call. If all beings are busy, it falls back
to the normal orchestrator path. This eliminates the 30–60 s queue delay for interactive
Discord tasks. The runner is started immediately after `updateTaskStatus(... 'assigned', leader, leaderId)`.
The orchestrator's 5-second tick still reconciles any remaining `pending` tasks.
- **crash recovery**: on restart, any task with `status: "in-progress"` in queue.json is
  automatically re-launched. The previous Docker container (if any) is removed first
  (`docker rm -f`) to avoid container name conflicts.

Within this plane, AI beings provide:
- task understanding and decomposition,
- collaborative decision-making across related world tasks,
- memory-aware planning using world/project/team context,
- reflective learning and capability growth.

It does **not** need to execute all coding/research commands directly.

### Execution Plane (Sandbox)

Each world task gets exactly **one Docker container**. Inside that container, the team
executes together. Two execution models exist:

---

#### v1 — Single session (current implementation ✅)

One `claude` CLI process, one session. The leader drives the entire task —
member beings exist only as roles named in the prompt. The leader acts and
writes on behalf of everyone.

```text
Docker container
  └─ claude CLI  (leader session)
       · executes the full task sequentially
       · writes progress.json
       · at the end: writes self-notes + profile.json for all members
```

Trade-off: simple and reliable, but members don't truly act independently.

---

#### v2 — Leader + subagents (planned, not yet implemented 🧪)

The leader session uses Claude Code's built-in `Task` tool to spawn each team
member as an independent subagent. Members run concurrently or sequentially
within the same container, sharing the same volume mounts.

```text
Docker container
  └─ claude CLI  (leader session — aria)
       ├─ Task("You are blake. Create a GitHub issue signed blake/Developer…")
       │     └─ subagent process  (blake)
       ├─ Task("You are aria. Reply to blake's issue with your opinion…")
       │     └─ subagent process  (aria)
       └─ Task("You are blake. Implement the agreed program…")
             └─ subagent process  (blake)
```

Each subagent is a real independent AI execution — not a prompt persona.
All subagents share the same `/workspace` volume mounts as the leader.

> **Status:** Implemented (experimental ✅). Set `EXECUTION_MODE=v2` to activate.
> Key unknown: whether the configured model will reliably invoke the `Task` tool.
> Test and observe. Falls back gracefully — if the model ignores the Task instructions,
> it will just execute as a single session (v1 behavior).

---

**Common to both versions:**

Sandbox responsibilities:
- execute coding/research workflows under leader coordination,
- write progress.json checkpoints after every meaningful step,
- write self-notes and update profile.json for all team members at task end,
- call external APIs (GitHub etc.) to produce deliverables.

Assignment invariants:
- a single `beingId` can belong to only one world task at a time (task-level exclusivity),
- once assigned, that being is considered `busy` and cannot be assigned to another world task,
- the being returns to `idle` only after the task completes and profile.json is updated.

### Being Capability Iteration (ASCII)

```text
       prior skills + memory
          |
          v
      +---------------------------------------------+
      | Assigned Being (leader/member)              |
      | decides + executes for current world task   |
      +------------------------+--------------------+
                |
                | task completes → leader writes for every team member:
                |   world/beings/{id}/memory/self-notes/{ts}.json
                |   world/beings/{id}/profile.json  (skills, lastTaskId)
                v
      +---------------------------------------------+
      | World Being Memory  (personal growth)        |
      | - world/beings/{id}/memory/self-notes/      |
      | - world/beings/{id}/skills/                 |
      +------------------------+--------------------+
                |
                | optionally promoted
                v
      +---------------------------------------------+
      | World Shared Skills  (cross-being reuse)     |
      | - world/shared/skills/                      |
      +------------------------+--------------------+
                |
                v
           future world tasks
```

## Data and State Layers

### State Layer Graph (ASCII)

```text
         execution details (deep)
   +---------------------------------------------+
   | Execution Artifacts                         |
   | - GitHub repo: ALL intermediate + final      |
   |   results committed continuously; README.md  |
   |   updated with results summary at task end   |
   | - output/{taskId}/ deliverables (local copy) |
   | - world/tasks/{taskId}/progress.json        |
   +----------------------+----------------------+
                 |
                 | sync contract
                 v
   +---------------------------------------------+
   | world/ (creator-facing, intervention-ready) |
   | - world/tasks/queue.json                    |
   | - world/tasks/{taskId}/progress.json        |
   | - world/memory/project/{projectId}.json     |
   | - world/reports/escalations.json            |
   +----------------------+----------------------+
                 |
                 | consumed by
                 v
   +---------------------------------------------+
   | Creator decisions + future world tasks      |
   | (cross-task continuity and reuse)           |
   +---------------------------------------------+
```

### World-facing state (`world/`)

This is the creator-facing state used for monitoring and intervention:
- `world/tasks/queue.json`
- `world/tasks/{taskId}/progress.json`
- `world/reports/escalations.json`
- `world/memory/project/{projectId}.json`
- `world/memory/world.json`

Goals:
- concise,
- decision-ready,
- easy to read by humans and other world tasks.

### Execution-facing state (GitHub + output/)

This is the technical state for implementation details:
- source changes,
- tests/logs,
- task-specific status and checkpoints,
- reproducible recovery anchors.

The creator may inspect this level when needed, but daily operations should not depend on it.

## Synchronization Contract

A running task must continuously synchronize key execution signals into `world/`.

Minimum expected sync outputs:
- task status,
- percent complete,
- current summary,
- latest checkpoint summary,
- blockers and escalation needs,
- intervention acknowledgements.

Skill sync outputs (stage-boundary):
- candidate skill files written to `world/beings/{id}/skills/`,
- being-level skill updates (`world/beings/{id}/skills/`),
- optional promoted shared skills (`world/shared/skills/`),
- metadata linking skill origin to task/repo/checkpoint.

This contract enables low-token operator monitoring with `vg` and keeps
cross-task reuse available to future work.

## Sandbox Isolation

Isolation is enforced through **precise Docker volume mounts** — not prompt constraints.
Each container sees only the subset of the host filesystem it is allowed to access.

### Volume Mount Map

```text
Host path                                    Container path                          Mode
────────────────────────────────────────────────────────────────────────────────────────
world/memory/world.json                  →   /workspace/world/memory/world.json      :ro
world/tasks/{taskId}/                    →   /workspace/world/tasks/{taskId}/         :rw
world/tasks/{taskId}/claude-home/         →   /home/sandbox/.claude/                   :rw
world/beings/{assignedId}/  (×N beings)  →   /workspace/world/beings/{assignedId}/   :rw
world/shared/                            →   /workspace/world/shared/                 :ro
output/{taskId}/                         →   /workspace/output/                       :rw
src/sandbox/entrypoint.mjs              →   /workspace/src/sandbox/entrypoint.mjs   :ro
src/sandbox/mcp-servers.mjs             →   /workspace/src/sandbox/mcp-servers.mjs  :ro
AGENTS.md                                →   /workspace/AGENTS.md                    :ro
```

### What the container CAN and CANNOT do

| Action | Allowed? | Reason |
|--------|----------|--------|
| Write progress.json for its task | ✅ | `/workspace/world/tasks/{taskId}/` is rw |
| Write task outputs / deliverables | ✅ | `output/{taskId}/` → `/workspace/output/` :rw; isolated per task |
| Persist Claude conversation history | ✅ | `world/tasks/{taskId}/claude-home/` → `/home/sandbox/.claude/` :rw; conversation JSONL in `claude-home/projects/` |
| Read dayCount from world.json | ✅ | `/workspace/world/memory/world.json` is ro |
| Update its own beings' profile.json | ✅ | `/workspace/world/beings/{id}/` is rw |
| Call tools / MCP servers | ✅ | World-shared tools injected at startup via `--mcp-config` |
| Read or write another task's progress | ❌ | That task dir is not mounted |
| Read or write another being's memory | ❌ | That being dir is not mounted |
| Modify source code | ❌ | `src/` is not mounted (only entrypoint.mjs ro) |
| Read world queue / task list | ❌ | `world/tasks/queue.json` is not mounted |

### World-shared Tools and MCP Servers

There are **two separate MCP registries** — one per runtime:

| Registry | Used by | Managed via |
|---|---|---|
| `world/shared/mcp-servers.json` | Task runner sandbox (beings in Docker) | `npm run setup` |
| `.claude/mcp-servers.json` | Discord bot (`handleMention` SDK session) | Edit file directly |
| `world/shared/skills/` | Task runner sandbox (beings read at task start) | `npm run setup` |
| `.claude/skills/<name>/SKILL.md` | Discord bot (SDK auto-discovers via `settingSources: ['project']`) | Create directory + SKILL.md |

Both MCP files are **gitignored** (may contain auth tokens).

**Task runner MCP:** Sandbox beings use servers configured in `src/sandbox/mcp-servers.mjs` (hardcoded world defaults) merged with `world/shared/mcp-servers.json` (operator additions via `npm run setup`). Applied to every `claude` invocation via `--mcp-config`.

Runtime MCP config generation normalizes legacy server records automatically:
- `transport: streamableHttp/http/sse/stdio` is converted to Claude CLI schema `type: http/sse/stdio`.
- `transport` field is removed in generated `/tmp/vibeguild-mcp.json`.
- Existing `world/shared/mcp-servers.json` entries remain backward compatible.

**Discord bot MCP:** `handleMention` in `world.ts` loads `.claude/mcp-servers.json` and passes it as `mcpServers` to the SDK `query()` call. Edit this file directly to add/remove bot MCP servers.

### Sync mechanism (real-time)

The core design goal: **the creator can observe task execution as it happens and intervene
at any moment** — redirect, add a constraint, or abort — without waiting for a task to finish.

This is achieved through continuous progress reporting from the sandbox to the world:

```text
 Sandbox container (entrypoint.mjs)
     │
     │  Leader writes world/tasks/{taskId}/progress.json after every meaningful step:
     │    { status, percentComplete, summary, checkpoints: [{time, message}], artifacts?,
     │      question? }   ← question is present only when status='waiting_for_human'
     │
     │  Volume mount makes this a direct write to the host filesystem —
     │  no network, no copy, no delay.
     ▼
 Host filesystem  (same physical file, seen by both sides)
     │
     │  chokidar* detects the file change via OS-native event (no polling)
     │  and immediately fires an onProgress callback in world.ts
     ▼
 Creator console
     📍 [dana→c54634e4] ████░░░░░░ 40% — Calling GitHub API to create footprint files
          ↳ Created footprints/dana.md successfully

     📍 [dana→c54634e4] ██████████ 100% — Task completed. All footprint files committed.
```

*chokidar: a Node.js file-watching library backed by OS-native filesystem events
(ReadDirectoryChangesW on Windows, inotify on Linux). Near-zero latency, no polling loop.

Completion gating semantics:
- Task completion is validated from synced `progress.json` status, not from container exit code alone.
- Auto-generated sandbox checkpoints (start/finish) do not count as meaningful execution evidence.
- If a sandbox exits without meaningful progress evidence, the run is marked `failed` (prevents false-complete tasks).
- Operator status tooling (`vg progress`) reads checkpoint fields compatibly (`at/description` and legacy variants).

Runtime logging and repo details:
- Every task persists sandbox runtime logs under `world/tasks/{taskId}/logs/` (e.g., `claude-code.log`, `runtime.log`, `progress-events.ndjson`, `docker.log`).
- If `claude` exits `0` with empty stdout/stderr while `--mcp-config` is enabled, sandbox treats it as an MCP/provider compatibility silent-exit and retries once without `--mcp-config` (still Claude CLI, not raw API).
- Alignment resume sessions (`waiting_for_human` -> re-launch) now have a hard timeout guard; on timeout/error with MCP enabled, sandbox retries once without MCP before failing the task explicitly.
- In Docker mode, task repo resolution/creation is owned by sandbox entrypoint (not host orchestrator).
- Naming: `task-<normalized-task-title>-<taskId8>`; reuse exact match first, then latest prefix match, else create new.
- Missing token or repo-resolution/create failure marks the task as `failed`.
- Task leaders are instructed to maintain a repo-side details folder `runtime-details/{taskId}/` and sync it repeatedly during execution.

**When to intervene:** if a checkpoint looks wrong, stalls, or the summary reveals a
misunderstanding, the creator can immediately inject a correction — before the being
wastes more turns going in the wrong direction.

Inverse direction (creator → container):

```text
 Creator types: /msg --task <id> <message>
     │
     ▼
 world.ts writes world/tasks/{taskId}/inbox.json  (via volume mount → same file)
     │
     │  Container polls inbox.json between tool calls
     │  reads the message, clears inbox, adjusts execution
     ▼
 Claude CLI incorporates instruction → course-corrects in next tool call
```

### Why file-system sync instead of API/network

- **Zero latency** — OS-level file events, no polling interval
- **No network surface** — container needs no inbound ports, no server to run
- **Crash-safe** — every checkpoint is already persisted on host disk; if the container
  crashes mid-task, the last written checkpoint survives for recovery
- **Simple recovery** — restart a failed container; progress.json already holds the last
  known state so the being can resume from the checkpoint instead of starting over

## Intervention Model

Two directions of intervention: **creator-initiated** (you spot a problem) and
**leader-initiated** (the being itself signals it needs guidance).
Both converge on the same multi-turn alignment conversation.

| | `/pause --task` | `waiting_for_human` |
|---|---|---|
| Who initiates | Creator | Leader |
| How leader stops | `pause.signal` file → entrypoint kills Claude via SIGTERM (no LLM needed) | Leader writes status and exits Claude process |
| Container state | Running (no docker freeze) | Running |
| Conversation | Multi-turn, same inbox/re-launch loop | Multi-turn, same inbox/re-launch loop |
| End condition | Creator types `/done` | Leader writes `in-progress` (or creator types `/done`) |

### Intervention Flow (ASCII)

```text
── Creator-initiated ────────────────────────────────────────────────────────

  /pause --task <id> [msg]      Send a MEETUP REQUEST to the leader's inbox.
     │                          Leader finishes its current tool call, then
     │                          stops, writes waiting_for_human, and comes
     │                          to align. Same multi-turn conversation as
     │                          leader-initiated alignment.
     │
     ▼
  (alignment mode — same as leader-initiated, see below)
     │
     ▼
  /done                         End alignment. Leader resumes the task.

── Leader-initiated (Human Alignment Protocol) ──────────────────────────────────────────────────

  Leader writes progress.json:
    { status: "waiting_for_human", question: "<specific decision needed>", ... }
     │
     │  chokidar fires onProgress → host detects waiting_for_human
     ▼
  Host prints:
    🤔 [aria→c54634e4] Leader needs your input:
       "Should I target the v1 API or v2 API for the integration?"
       ► Type your reply. Type /done to let leader proceed independently.
     │
     │  Container stays RUNNING (not docker-paused).
     │  entrypoint is actively polling inbox.json every 3 seconds.
     │
     │  ← Human types reply (can be multi-turn)
     ▼
  Everything human types goes straight to inbox.json (alignment mode).
  entrypoint reads the message → re-launches Claude with full conversation history.
     │
     │  Claude either:
     │   (a) writes status="in-progress" → resumes task normally → alignment over
     │   (b) writes status="waiting_for_human" again → next question shown
     ▼
  Conversation continues until leader is satisfied.
  /done at any point sends "proceed with your best judgment" and exits alignment mode.

── Global meetup (all tasks) ────────────────────────────────────────────────

  /meetup-freeze  (via signals.json / vg CLI)   Pause ALL tasks simultaneously.
  /done                                          Resume all.
```

### Human Alignment Protocol (leader-initiated)

The leader can signal that it needs operator input before proceeding. This is a
**voluntary pause** — the leader writes `waiting_for_human` and exits the current
Claude session. The container stays running; `entrypoint.mjs` polls `inbox.json`.

The alignment is a **multi-turn conversation**, not a single Q&A handshake:
- Each message the operator sends triggers a fresh Claude re-launch.
- Claude receives the full conversation history on each re-launch.
- Claude can ask follow-up questions (write `waiting_for_human` again) as many
  times as needed until it has enough clarity to proceed.
- When Claude is ready, it writes `status: "in-progress"` and continues the task.
- The operator can type `/done` at any time to inject a "proceed independently"
  message and exit alignment mode without waiting for Claude to ask again.

Conditions for requesting alignment:
- The task description is ambiguous in a way that would materially change the outcome.
- A consequential binary choice has no clear winner from the task context.
- External access or permissions are needed that the leader doesn't have.

**Not** appropriate for minor choices, research decisions, or anything inferrable from context.

Technical flow — `/pause --task` (operator-initiated):
1. `world.ts` writes `world/tasks/{id}/pause.signal` and sets `aligningTaskId`.
2. Inside the container, `runClaudeInterruptible()` polls for `pause.signal` every 2 s
   concurrently while Claude runs. When detected: signal file is deleted, Claude is killed
   via SIGTERM — **no LLM cooperation needed**.
3. Entrypoint writes `waiting_for_human` to progress.json itself (with the MEETUP message
   as the question) and enters the alignment loop.
4. `chokidar` on the host detects `waiting_for_human` → host shows `🤔` prompt.

Technical flow — leader-initiated (`waiting_for_human`):
1. Leader writes `status: "waiting_for_human"`, `question: "…"` to progress.json and exits Claude.
2. `chokidar` fires → `onProgress` detects the status → host enters **alignment mode**, prints `🤔`.
3. Entrypoint alignment loop drains the inbox (clearing any stale messages), then waits for
   a fresh operator message (30 min timeout).
4. Operator types reply → message written to inbox → entrypoint re-launches Claude with
   full conversation history (`alignHistory[]` array). **No `in-progress` is written first** —
   that would immediately exit alignment mode on the host.
5. Re-launch sessions use a hard timeout guard (5 minutes per resume run) to prevent
   indefinite hangs during alignment.
6. If the resume run times out or errors with MCP enabled, sandbox retries once without MCP.
   If the fallback also fails, task status is set to `failed` explicitly (no infinite wait state).
7. Claude MUST write `waiting_for_human` to acknowledge the operator's message and confirm
   its updated plan before resuming. Host prints `💬 [leader] <acknowledgment>`.
8. Operator confirms ("可以" / "proceed") → Claude writes `in-progress` → loop exits.
9. Safety cap: 20 rounds maximum before auto-fail.

Verification snapshot (2026-02-24):
- Post-patch acceptance task `db240f61-63c5-4494-91af-eb56956e4baa` completed successfully.
- Output artifact `output/geo-acceptance-mcp-patched.txt` was generated with citation URLs.
- Runtime logs show clean Claude exit (`code=0`) and container completion.

### World Setup Assistant

A separate conversational interface for configuring world-shared resources.
Run in any terminal **independent of `npm start`**:

```sh
npm run setup
```

The assistant speaks natural language — you describe what you want and it handles the details.
Capabilities (task runner sandbox only):
- List, add, remove MCP servers (persisted to `world/shared/mcp-servers.json`)
- **Test** whether an MCP endpoint actually responds before committing it
- Add, remove shared skill files (`world/shared/skills/`)

For **Discord bot** MCP and skills, edit directly:
- MCP: `.claude/mcp-servers.json`
- Skills: `.claude/skills/<name>/SKILL.md`

Use `/task`, `/pause --task`, `/done` only in the `npm start` world terminal; do not use them in the setup terminal.

MCP changes take effect for **new** sandbox tasks; running containers are unaffected.

> Both `world/shared/mcp-servers.json` and `.claude/mcp-servers.json` are **gitignored** — they may contain auth tokens and must not be committed.

### /pause --task and alignment quick reference

```
/pause --task <id>               Ask leader to stop and align (sends a MEETUP REQUEST to inbox).
/pause --task <id> <message>     Same + include your opening message.
/msg --task <id> <message>       Inject a one-off message to a running task (no alignment mode).
/done                            End alignment. Leader resumes the task independently.

# Task revision — via natural conversation, NOT a slash command
# Just @mention the bot expressing dissatisfaction, e.g.:
#   "The blog post output has no images, just walls of text — please redo it"
#   "The geo strategy output is too short, please redo with more detail"
# The bot AI will identify which task you mean, extract your feedback,
# ask for confirmation, then internally dispatch /revise <id> <feedback>.
# Same team, same repo, same conversation history — picks up from where it left off.

# MCP servers and shared skills are managed via: npm run setup (separate terminal)
```

When in **alignment mode** (either side initiated it):
- You do NOT need `/msg --task` — just type your message directly.
- Each message you type is sent immediately to the task's inbox.
- Leader re-launches after each message with the full conversation history.
- Type `/done` to end the conversation and tell the leader to proceed on its own.

Both `/pause --task` and `waiting_for_human` enter the same alignment mode.
The only difference is who initiated it — you or the leader.

Intervention should target world-task boundaries, while sandbox internals remain
implementation details hidden behind runtime adapters.

## Time Semantics

World time (day/shift) is primarily an operational cadence, not the core progress metric.

For operator decisions, prioritize:
- task age,
- time since last meaningful checkpoint,
- blocker duration,
- intervention response time.

Day counters can remain as lightweight world chronology metadata.

## Why This Model

This model keeps orchestration and execution decoupled:
- runtime technology can evolve (local process, Docker, stronger sandbox),
- creator workflows stay stable (`world/` + `vg`),
- task-level technical detail remains traceable in dedicated repos.

In short: **repo answers “what happened in execution,” world answers “what should the creator do next.”**
## Discord Operator Notifications

Discord integration has two modes depending on which env vars are set.

### Mode A — Webhook only (one-way push)

Set `DISCORD_WEBHOOK_URL` in `.env`. All events push to one channel.

### Mode B — Bot (conversational @mention + slash commands + per-task threads)

Requires additionally `DISCORD_BOT_TOKEN` and `DISCORD_TASKS_CHANNEL_ID`.
`DISCORD_CONTROL_CHANNEL_ID` is only used for outbound webhook routing (optional label).

**Two-channel architecture:**
- **`#control-plane`** — ordinary text channel; world events pushed here via webhook; **primary place for @mentioning the bot**
- **`#tasks`** — **Forum channel**; each task automatically gets its own post (thread); all task progress is posted there via Bot API

**Extra capabilities over Mode A:**

- **Conversational @mention (primary interface)** — @mention the bot in **any channel or task thread** with natural language.
  The bot runs as a **stateful Claude Code SDK agent**: it uses `@anthropic-ai/claude-agent-sdk`'s `query()` function (the same SDK used by task runners), maintaining per-channel **session IDs** (server-side conversation state). "Yes" after a confirmation question is understood naturally — no regex, no separate confirmation state.
  When writing from a task's own Discord thread, the bot automatically scopes context to that task.
  Works in `#control-plane` (global context) or directly inside a task's forum post (task-scoped context):
  - Session ID is stored per channel (`channelId → sessionId`). Subsequent @mentions pass `resume: sessionId` to the SDK.
  - Claude receives a freshly-built world state snapshot on every call.
  - Full conversation continuity is maintained server-side by the SDK.
  ```
  @VibeGuild new task: write a blog post about feature flags
  @VibeGuild list tasks
  @VibeGuild status abc12345
  @VibeGuild pause abc12345 please review the research direction
  @VibeGuild msg abc12345: stop and wait for me
  @VibeGuild done
  ```
  The bot parses the intent, **confirms** destructive/creative actions before executing, then replies in the same channel with progress.

  **Confirmation flow for new tasks:**
  1. @mention with a task description → bot describes what it will do and asks "shall I proceed?" (does NOT yet queue the command)
  2. @mention `yes` → bot calls `node scripts/vg-cmd.mjs cmd "/task ..."` via Bash in the next SDK turn
  3. @mention `cancel` → bot acknowledges without executing
  (No separate pending-state machine — Claude reads the session history and decides.)

- **Native slash commands** — still available as fallback, registered automatically on startup:
  ```
  /new                   — open multiline modal to create a task
  /tasks                 — list all tasks
  /status <id>           — show task progress
  /pause <id> [message]  — pause for alignment
  /msg <id> <message>    — inject a message into running task
  /done                  — end alignment session
  ```
- **Per-task forum posts** — each task gets its own forum post in `#tasks` when it starts; all progress goes there via Bot API

**Bot setup:**
1. [discord.com/developers/applications](https://discord.com/developers/applications) → New Application → Bot → Reset Token → copy token
2. **Enable Privileged Gateway Intents** in the Bot page → scroll to "Privileged Gateway Intents" → enable **Message Content Intent** (required for @mention reading)
3. Use this invite URL (bot + slash commands scope, permissions=379968):
   ```
   https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot+applications.commands&permissions=379968
   ```
4. In Discord Server Settings → Members, confirm the bot appears with the `APP` badge
5. In the server Category that contains `#control-plane` and `#tasks`: Edit Category → Permissions → add VibeGuild bot → allow View Channels + Send Messages
6. On each channel, click **Sync Now** to inherit the category permissions

**.env additions:**
```sh
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
DISCORD_BOT_TOKEN=your-bot-token-here
DISCORD_CONTROL_CHANNEL_ID=<control-plane channel id>   # used for outbound label only
DISCORD_TASKS_CHANNEL_ID=<tasks forum channel id>
```

**Routing logic in `src/discord.ts`:**
- World/global events → webhook → `#control-plane`
- Task-specific events (progress, alignment) → Bot API → forum post thread in `#tasks`
- If no thread registered for a task yet → falls back to webhook → `#control-plane`
- @mention interactions → `messageCreate` Gateway event → per-channel `sessionId` lookup → `handleMention` callback → **Claude Code SDK** (`@anthropic-ai/claude-agent-sdk` `query()`) with `resume: sessionId` → multi-turn SDK loop (up to 10 turns) → plain text response via Bot API reply. Session ID stored back for next @mention in same channel.
- World commands queued by Claude via `node scripts/vg-cmd.mjs cmd "/task ..." <channelId>` Bash call during the SDK loop → drained by `drainDiscordPendingCmds()` after SDK completes. When a `/task` command carries a `channelId`, the **existing forum post is reused** (via `registerExistingThread`) instead of creating a new one — this handles the flow where the operator manually creates a `#tasks` post and @mentions the bot from it.
- Plain `/task` calls (no channelId) and all other commands → `processLine()` dispatched.
- Slash command interactions → `interactionCreate` Gateway event → `commandCallback` in `world.ts` → response via webhook to `#control-plane`

### What gets mirrored

| Event | Discord destination |
|---|---|
| World startup | Main channel |
| Task runner starts | Main channel |
| Task progress checkpoint 📍 | Task's thread (or main channel if no thread yet) |
| Alignment requested 🤔 | Task's thread |
| Alignment reply 💬 | Task's thread |
| Alignment resolved ✅ | Task's thread |
| Orchestrator CC reply 🧠 | Main channel |
| Tasks assigned 📋 | Main channel |
| Task recovery ♻️ | Main channel |

### Implementation

`src/discord.ts` — `notifyDiscord()`, `notifyTask()`, `createTaskThread()`, `initDiscordBot()`, `flushDiscord()`, `sendDirectReply()`, `getActiveThreadLinks()`, `getTaskIdByChannelId()`
Uses `discord.js` for Gateway WebSocket connection, @mention handling (`messageCreate` with `GuildMessages` + `MessageContent` intents), and slash command registration.
`initDiscordBot(onCommand, onMention)` accepts two callbacks from `world.ts`:
- `onCommand(line)` — processes slash commands (same as stdin)
- `onMention(userMessage, username, userId, channelId, sessionId, reply)` — AI-powered handler implemented in `world.ts` using `@anthropic-ai/claude-agent-sdk`

`handleMention` in `world.ts` runs the **Claude Code SDK `query()` loop** (up to 10 turns):
1. Calls `query({ prompt, options: { resume: sessionId, allowedTools, settingSources: ['project'], permissionMode: 'bypassPermissions', maxTurns: 10, mcpServers, ... } })`.
2. On first call (no session): sends full role + behaviour instructions + world state snapshot in `prompt`.
3. On subsequent calls (has session): sends fresh world state + user message only; session history maintained server-side by SDK.
4. Captures `session_id` from the `system/init` event; returns it so discord.ts can store it for the next call.
5. After the loop: drains `world/discord-pending-cmds.json` (populated by Claude calling `node scripts/vg-cmd.mjs cmd "..."` via Bash) and dispatches each command to `processLine()`.

Agent Skills in `.claude/skills/<name>/SKILL.md` are auto-discovered by the SDK via `settingSources: ['project']`.

Available tools for the Discord bot session (same as task runners):
| Tool | Purpose |
|---|---|
| `Bash` | Read world state via `vg.mjs`, queue commands via `vg-cmd.mjs` |
| `Read` | Read files under `world/` or `output/` directly |
| `Write` | Write scratch files if needed |
| `WebSearch` / `WebFetch` | External research |

World command dispatch (queued by Claude via Bash):
| Bash call | Effect |
|---|---|
| `node scripts/vg-cmd.mjs cmd "/task <desc>"` | Create new task (after operator confirms) |
| `node scripts/vg-cmd.mjs cmd "/revise <id> <feedback>"` | Revise a task |
| `node scripts/vg-cmd.mjs cmd "/pause --task <id> [msg]"` | Pause a task for alignment |
| `node scripts/vg-cmd.mjs cmd "/msg --task <id> <text>"` | Send message to running task |
| `node scripts/vg-cmd.mjs cmd "/done"` | End alignment |

No more `pendingConfirm` state machine — confirmation is handled through SDK session history.
Wired into `src/world.ts`. Slash commands registered to all bot guilds on `ready`.

> **⚠️ Privileged Intent**: `MessageContent` intent must be enabled in the Discord Developer Portal (Bot page → Privileged Gateway Intents) before @mention reading will work.
