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
   | - GitHub commits / PRs / issues             |
   | - output/ deliverables (blogs, reports…)    |
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
world/beings/{assignedId}/  (×N beings)  →   /workspace/world/beings/{assignedId}/   :rw
world/shared/                            →   /workspace/world/shared/                 :ro
output/                                  →   /workspace/output/                       :rw
src/sandbox/entrypoint.mjs              →   /workspace/src/sandbox/entrypoint.mjs   :ro
src/sandbox/mcp-servers.mjs             →   /workspace/src/sandbox/mcp-servers.mjs  :ro
AGENTS.md                                →   /workspace/AGENTS.md                    :ro
```

### What the container CAN and CANNOT do

| Action | Allowed? | Reason |
|--------|----------|--------|
| Write progress.json for its task | ✅ | `/workspace/world/tasks/{taskId}/` is rw |
| Read dayCount from world.json | ✅ | `/workspace/world/memory/world.json` is ro |
| Update its own beings' profile.json | ✅ | `/workspace/world/beings/{id}/` is rw |
| Call tools / MCP servers | ✅ | World-shared tools injected at startup via `--mcp-config` |
| Read or write another task's progress | ❌ | That task dir is not mounted |
| Read or write another being's memory | ❌ | That being dir is not mounted |
| Modify source code | ❌ | `src/` is not mounted (only entrypoint.mjs ro) |
| Read world queue / task list | ❌ | `world/tasks/queue.json` is not mounted |

### World-shared Tools and MCP Servers

Sandbox beings can call tools and MCP servers. World-shared servers are configured
once in `entrypoint.mjs` (`setupMcpConfig()`) and applied to every `claude` invocation
via `--mcp-config`. Authorization tokens reuse existing env vars — no extra secrets.

To add a new MCP server or tool: add an entry to `src/sandbox/mcp-servers.mjs` (hardcoded world defaults) or use `npm run setup` in a separate terminal for the conversational setup assistant (persisted to `world/shared/mcp-servers.json`) — no other files need to change.

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
5. Claude MUST write `waiting_for_human` to acknowledge the operator's message and confirm
   its updated plan before resuming. Host prints `💬 [leader] <acknowledgment>`.
6. Operator confirms ("可以" / "proceed") → Claude writes `in-progress` → loop exits.
7. Safety cap: 20 rounds maximum before auto-fail.

### World Setup Assistant

A separate conversational interface for configuring world-shared resources.
Run in any terminal **independent of `npm start`**:

```sh
npm run setup
```

The assistant speaks natural language — you describe what you want and it handles the details.
Capabilities:
- List, add, remove MCP servers (persisted to `world/shared/mcp-servers.json`)
- **Test** whether an MCP endpoint actually responds before committing it
- Add, remove shared skill files (`world/shared/skills/`)

MCP changes take effect for **new** sandbox tasks; running containers are unaffected.

> `world/shared/mcp-servers.json` is **gitignored** — it may contain auth tokens and must not be committed.

### /pause --task and alignment quick reference

```
/pause --task <id>               Ask leader to stop and align (sends a MEETUP REQUEST to inbox).
/pause --task <id> <message>     Same + include your opening message.
/msg --task <id> <message>       Inject a one-off message to a running task (no alignment mode).
/done                            End alignment. Leader resumes the task independently.

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
