# LP;HU — Architecture

## What It Is

LP;HU is a task execution framework that accepts tasks, runs them in isolated sandbox
containers, and keeps the operator in control with real-time visibility and intervention.

Each task runs as an independent Claude CLI process inside a Docker container. The operator
can pause at any moment, inject instructions, and resume. Execution truth lives in the
GitHub repo; operator-facing truth lives in `world/`.

Supported task types:
- content and research tasks
- coding and debugging tasks
- multi-step tasks that depend on outputs from prior tasks

---

## Core Design Principles

1. **Operator sovereignty first**
   - The operator can pause, resume, and inject instructions at any time.
   - Operator visibility must not depend on reading low-level execution files.

2. **Two-plane architecture**
   - **Control Plane (Host):** task scheduling, lifecycle state, intervention, world memory.
   - **Execution Plane (Sandbox):** one Docker container per task; Claude CLI runs inside.

3. **Dual truth model**
   - **Execution truth:** GitHub repo + runtime artifacts — all intermediate and final results
     committed continuously. Survives container restarts; the recovery anchor for resuming tasks.
   - **Operator truth:** `world/` summaries and metadata — concise, decision-ready.

4. **Cross-task continuity**
   - Later tasks may build on completed tasks through `world/memory/project/` metadata.

5. **Capability evolution through SKILLs**
   - Capabilities are updated by editing SKILL files and re-running the coding agent.
   - No runtime self-learning. No over-engineering for future model capabilities.

---

## Runtime Model

### High-Level Architecture (ASCII)

```text
                    +------------------------------------+
                    |     Operator Console               |
                    |  (vg CLI · pause · inject msg)     |
                    +------------------+-----------------+
                                       |
                                       v
+--------------------------------------------------------------------------+
|                     Control Plane  (Host Process)                        |
|                                                                          |
|   Scheduler (5 s tick)                                                  |
|   · start runners for queued tasks                                      |
|   · detect completed / failed runners                                   |
|   · drain signals (pause, inject…)                                      |
|                                                                          |
|   chokidar ──────── watches world/tasks/*/progress.json ──────────────► |
|                     fires onProgress → operator console                 |
|                                                  │                       |
|   operator console ─── /msg --task <id> <text> ──►  inbox.json (rw)  ──►|
|                     inject message mid-execution    sandbox reads next  |
+──────────────────────────────┬───────────────────────────────────────────+
                               │  one sandbox per task
                               │  (multiple tasks → multiple sandboxes in parallel)
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
   +─────────────────+ +─────────────────+ +─────────────────+
   │ Sandbox task A  │ │ Sandbox task B  │ │ Sandbox task C  │  (Docker containers)
   │                 │ │                 │ │                 │
   │  claude CLI     │ │  claude CLI     │ │  claude CLI     │
   │  (one process)  │ │  (one process)  │ │  (one process)  │
   │                 │ │                 │ │                 │
   │  Mounts (rw):   │ │  Mounts (rw):   │ │  Mounts (rw):   │
   │  tasks/{id}/    │ │  tasks/{id}/    │ │  tasks/{id}/    │
   │  output/        │ │  output/        │ │  output/        │
   │  Mounts (ro):   │ │  Mounts (ro):   │ │  Mounts (ro):   │
   │  world.json     │ │  world.json     │ │  world.json     │
   │  shared/        │ │  shared/        │ │  shared/        │
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

Responsibilities:
- task queue management and lifecycle state
- starting / monitoring sandbox runners
- crash recovery: on restart, any `in-progress` task in queue.json is re-launched
  (`docker rm -f` first to avoid container name conflicts)
- escalation handling and operator intervention
- syncing task summaries into `world/`

**Discord fast-path:** When a task is created via Discord, the system directly assigns and
starts the runner without waiting for a scheduler tick. This eliminates the 30–60 s queue
delay for interactive Discord tasks.

### Execution Plane (Sandbox)

Each task gets exactly **one Docker container** with one `claude` CLI process.

```text
Docker container
  └─ claude CLI
       · executes the full task
       · writes progress.json checkpoints after every meaningful step
       · commits intermediate and final results to GitHub repo continuously
```

Sandbox responsibilities:
- execute the task end-to-end
- write `progress.json` checkpoints continuously
- commit all deliverables to the GitHub task repo
- call external APIs (GitHub, web, MCP servers) to produce results

---

## Data and State Layers

### State Layer Graph (ASCII)

```text
         execution details (deep)
   +---------------------------------------------+
   | Execution Artifacts                          |
   | - GitHub repo: ALL results committed         |
   |   continuously; README.md updated at end     |
   | - output/{taskId}/  deliverables (local)     |
   | - world/tasks/{taskId}/progress.json         |
   +----------------------+----------------------+
                 |
                 | sync contract
                 v
   +---------------------------------------------+
   | world/ (operator-facing, intervention-ready) |
   | - world/tasks/queue.json                     |
   | - world/tasks/{taskId}/progress.json         |
   | - world/memory/project/{projectId}.json      |
   | - world/reports/escalations.json             |
   +----------------------+----------------------+
                 |
                 | consumed by
                 v
   +---------------------------------------------+
   | Operator decisions + future tasks            |
   | (cross-task continuity and reuse)            |
   +---------------------------------------------+
```

### Operator-facing state (`world/`)

- `world/tasks/queue.json` — task queue and lifecycle state
- `world/tasks/{taskId}/progress.json` — real-time progress and checkpoints
- `world/reports/escalations.json` — escalations needing operator attention
- `world/memory/project/{projectId}.json` — cross-task context
- `world/memory/world.json` — global world metadata

Goals: concise, decision-ready, easy to read for both humans and future tasks.

### Execution-facing state (GitHub + output/)

- source changes, tests, logs
- task-specific status and checkpoints
- reproducible recovery anchors

The operator may inspect this level when needed but daily operations should not depend on it.

---

## Sandbox Isolation

Isolation is enforced through **precise Docker volume mounts** — not prompt constraints.

### Volume Mount Map

```text
Host path                                    Container path                          Mode
────────────────────────────────────────────────────────────────────────────────────────
world/memory/world.json                  →   /workspace/world/memory/world.json      :ro
world/tasks/{taskId}/                    →   /workspace/world/tasks/{taskId}/         :rw
world/tasks/{taskId}/claude-home/         →   /home/sandbox/.claude/                   :rw
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
| Persist Claude conversation history | ✅ | `world/tasks/{taskId}/claude-home/` → `/home/sandbox/.claude/` :rw |
| Read dayCount from world.json | ✅ | `/workspace/world/memory/world.json` is ro |
| Read world-shared skills and MCP config | ✅ | `/workspace/world/shared/` is ro |
| Call tools / MCP servers | ✅ | World-shared tools injected at startup via `--mcp-config` |
| Read or write another task's progress | ❌ | That task dir is not mounted |
| Modify source code | ❌ | `src/` is not mounted (only entrypoint.mjs ro) |
| Read world queue / task list | ❌ | `world/tasks/queue.json` is not mounted |

### MCP Servers and Shared Skills

Two separate MCP registries:

| Registry | Used by | Managed via |
|---|---|---|
| `world/shared/mcp-servers.json` | Task sandbox (Claude CLI in Docker) | `npm run setup` |
| `.claude/mcp-servers.json` | Discord bot (SDK session) | Edit file directly |
| `world/shared/skills/` | Task sandbox (read at task start) | `npm run setup` |
| `.claude/skills/<name>/SKILL.md` | Discord bot (SDK auto-discovers) | Create directory + SKILL.md |

Both MCP files are **gitignored** (may contain auth tokens).

**Task MCP:** Configured in `src/sandbox/mcp-servers.mjs` (hardcoded defaults) merged with
`world/shared/mcp-servers.json` (operator additions). Applied to every `claude` invocation
via `--mcp-config`. Runtime config normalizes legacy `transport:` fields to Claude CLI schema.

**Discord bot MCP:** `handleMention` in `world.ts` loads `.claude/mcp-servers.json` and
passes it as `mcpServers` to the SDK `query()` call.

---

## Synchronization Contract

A running task must write to `progress.json` continuously so the operator can observe
execution in real time and intervene at any moment.

Minimum sync outputs:
- task status
- percent complete
- current summary
- latest checkpoint description
- blockers / escalation needs
- intervention acknowledgements

### Sync Mechanism (real-time)

```text
 Sandbox container (entrypoint.mjs)
     │
     │  Claude writes world/tasks/{taskId}/progress.json after every meaningful step:
     │    { status, percentComplete, summary, checkpoints: [{time, message}],
     │      question? }   ← question present only when status='waiting_for_human'
     │
     │  Volume mount → direct write to host filesystem, no network, no copy.
     ▼
 Host filesystem  (same physical file seen by both sides)
     │
     │  chokidar detects change via OS-native event (no polling)
     │  immediately fires onProgress callback in world.ts
     ▼
 Operator console
     📍 [task:c54634e4] ████░░░░░░ 40% — Calling GitHub API to create footprint files
     📍 [task:c54634e4] ██████████ 100% — Task completed. All files committed.
```

Completion gating:
- Task completion is validated from synced `progress.json` status, not container exit code alone.
- Auto-generated start/finish checkpoints do not count as meaningful execution evidence.
- If a sandbox exits without meaningful progress, the task is marked `failed`.

Runtime logging:
- Logs persisted under `world/tasks/{taskId}/logs/` (claude-code.log, runtime.log, docker.log).
- If `claude` exits 0 with empty output while `--mcp-config` is enabled → retry once without MCP.
- Task repo naming: `task-<normalized-title>-<taskId8>`; reuse exact match first, else create new.

---

## Intervention Model

Two directions of intervention: **operator-initiated** (you spot a problem) and
**agent-initiated** (the agent signals it needs guidance). Both use the same
multi-turn alignment conversation.

| | `/pause --task` | `waiting_for_human` |
|---|---|---|
| Who initiates | Operator | Agent |
| How agent stops | `pause.signal` file → SIGTERM (no LLM needed) | Agent writes status and exits Claude |
| Container state | Running | Running |
| Conversation | Multi-turn inbox/re-launch loop | Multi-turn inbox/re-launch loop |
| End condition | Operator types `/done` | Agent writes `in-progress` (or `/done`) |

### Intervention Flow (ASCII)

```text
── Operator-initiated ───────────────────────────────────────────────────────

  /pause --task <id> [msg]    Write pause.signal → entrypoint kills Claude (SIGTERM).
                              Entrypoint writes waiting_for_human, enters alignment loop.
     │
     ▼
  (alignment mode — same as agent-initiated below)
     │
     ▼
  /done                       End alignment. Agent resumes the task.

── Agent-initiated (Human Alignment Protocol) ───────────────────────────────

  Agent writes progress.json:
    { status: "waiting_for_human", question: "<specific decision needed>", ... }
     │
     │  chokidar fires onProgress → host detects waiting_for_human
     ▼
  Host prints:
    🤔 [task:c54634e4] Agent needs your input:
       "Should I target the v1 API or v2 API?"
       ► Type your reply. Type /done to let agent proceed independently.
     │
     │  Container stays RUNNING, entrypoint polls inbox.json every 3 seconds.
     │
     │  ← Operator types reply (can be multi-turn)
     ▼
  Message written to inbox.json → entrypoint re-launches Claude with full history.
     │
     │  Claude either:
     │   (a) writes status="in-progress" → resumes → alignment over
     │   (b) writes status="waiting_for_human" again → next question shown
     ▼
  Conversation continues until agent has enough clarity to proceed.
  /done sends "proceed with your best judgment" and exits alignment mode.

── Global pause ─────────────────────────────────────────────────────────────

  /meetup-freeze    Pause ALL running tasks simultaneously.
  /done             Resume all.
```

### Human Alignment Protocol (agent-initiated)

The agent voluntarily pauses by writing `waiting_for_human` and exiting the Claude session.
The container stays running; `entrypoint.mjs` polls `inbox.json`.

The alignment is a **multi-turn conversation**, not a single Q&A:
- Each operator message triggers a fresh Claude re-launch with full conversation history.
- Claude can ask follow-up questions as many times as needed.
- When ready, Claude writes `status: "in-progress"` and continues.
- Operator can type `/done` at any time to end the conversation.

When to request alignment:
- Task description is ambiguous in a way that would materially change the outcome.
- A consequential binary choice has no clear winner from context.
- External access or permissions are needed.

**Not** appropriate for minor choices or anything inferrable from context.

Technical flow — `/pause --task`:
1. `world.ts` writes `pause.signal` and sets `aligningTaskId`.
2. `runClaudeInterruptible()` polls for `pause.signal` every 2 s. When detected: signal deleted, Claude killed via SIGTERM.
3. Entrypoint writes `waiting_for_human` and enters alignment loop.

Technical flow — agent-initiated:
1. Agent writes `status: "waiting_for_human"`, `question: "…"` and exits.
2. `chokidar` fires → host enters alignment mode, prints `🤔`.
3. Entrypoint drains inbox, waits for operator message (30 min timeout).
4. Operator types reply → re-launches Claude with full history.
5. Resume sessions have a 5-minute timeout guard. On timeout with MCP enabled, retries once without MCP. If fallback fails, task marked `failed`.
6. Safety cap: 20 rounds maximum before auto-fail.

---

## World Setup Assistant

Configure world-shared resources in a **separate terminal** from `npm start`:

```sh
npm run setup
```

Capabilities (task sandbox only):
- List, add, remove MCP servers (`world/shared/mcp-servers.json`)
- Test whether an MCP endpoint responds before committing it
- Add, remove shared skill files (`world/shared/skills/`)

For Discord bot MCP and skills, edit directly:
- MCP: `.claude/mcp-servers.json`
- Skills: `.claude/skills/<name>/SKILL.md`

MCP changes take effect for **new** sandbox tasks only; running containers are unaffected.

---

## Cron Jobs

Inspired by [openclaw's cron pattern](https://github.com/openclaw/openclaw). Completed tasks
that recur on a schedule can be registered as cron jobs so the world enqueues them automatically.

### How it works

```
world/crons/{id}/job.json         ← one folder per job (mirrors world/tasks/)
       │
       ▼
startCronScheduler()              ← runs at world startup (src/cron/scheduler.ts)
       │
       ├─ schedule.kind = "cron"  → registered with node-cron (exact expression + TZ)
       ├─ schedule.kind = "every" → polled every 5s against nextRunAtMs
       └─ schedule.kind = "at"    → polled every 5s, fires once when past ISO timestamp
              │
              ├─ runtime = "local"  → runs inline (no container); posts stdout to Discord
              └─ runtime = "docker" → enqueueTask({ createdBy: "cron", discordThreadId }) → Docker container
                      │
                      ▼
              Task progress + output posted to the **cron-job's own Discord thread**
              (NOT a new tasks-forum post — `registerExistingThread(task.id, discordThreadId)`
               is called BEFORE `createTaskThread`, so the tasks-forum post is never created;
               all `notifyTask` calls route to the cron thread via the thread registry)
```

Each job has a top-level `runtime` field that controls execution:

| `runtime` | Execution | Payload fields |
|---|---|---|
| `"local"` | Inline in the Node.js process — no container overhead. Good for frequent heartbeat-style jobs. | `{ description: string }` — run.mjs is executed; stdout posted to the job's Discord thread |
| `"docker"` | Spawns a full AI Task in a Docker container (or local Task runner). Full Claude agent. All task notifications route to the **cron job's Discord thread** instead of the tasks forum. | `{ title, description, priority? }` — becomes the Task description |

### Execution isolation

`runtime: "docker"` jobs **do not share a sandbox**. Each fire creates a fresh Task. With
`RUNTIME_MODE=docker` (recommended for production) every Task gets its own Docker container.
`runtime: "local"` jobs run inline in the world process — no isolation, but no container cost.

### Discord Forum Integration

When `DISCORD_CRON_CHANNEL_ID` is set to the ID of a Discord **Forum** channel:

- On startup (or when a new job is added), the scheduler **creates one Forum post per enabled
  cron job** in that channel. The post title format is:
  `⏰ <name> | <schedule> [enabled/disabled]`.
- After every run, the scheduler **posts a run-summary message** to the job's forum thread:
  - ✅ success or ❌ failure
  - For `docker` jobs: Task ID that was spawned
  - Next scheduled run time
- When a job is enabled/disabled via `/cron enable|disable`, the thread title is updated to
  reflect the new status.
- Thread IDs are persisted in each `job.json` (`state.discordThreadId`) so associations
  survive world restarts — the scheduler re-registers the existing thread instead of creating
  a duplicate.

### Natural language management via Discord

Mention the operator bot in `#general` or `#control-plane` to manage cron jobs conversationally:

> `@bot show me the cron jobs`
> `@bot add a weekly trending analysis cron job every Monday at 9am Shanghai time`
> `@bot disable the weekly-review job`
> `@bot fire the daily-scraper job right now`

The bot reads the current cron state from `node scripts/vg.mjs cron` and queues the appropriate
`/cron list|add|remove|enable|disable|run` command after operator confirmation.

**Cron thread assistant** — @mention the bot directly **inside a cron job's forum post** for
focused single-job management:

| Your message | Bot behaviour |
|---|---|
| "这个 job 是干什么的？" | Immediately explains the config (schedule, payload, run stats) |
| "它跑起来了吗？" | Shows enabled/disabled, last run time and status, next run |
| "帮我禁用它" | Disables immediately (no confirmation — reversible) |
| "立即运行一次" | Fires the job immediately |
| "改成每小时跑一次" | Confirms the schedule change then queues `/cron add` (update coming) |
| "这个 job 被删了，帮我重装" | Asks you to describe what the job should do, then constructs `/cron add` JSON and confirms |

If a cron forum thread exists but the corresponding job has been **deleted from the store**, the
bot detects the orphaned thread and guides you through recreating the job via natural language.

### Schedule kinds

| Kind | Example | Description |
|---|---|---|
| `cron` | `"0 9 * * 1"` | 5-field cron expression, optional IANA TZ |
| `every` | `everyMs: 86400000` | Fixed interval in milliseconds |
| `at` | `"2026-03-01T09:00:00Z"` | One-shot ISO 8601 timestamp (UTC when no TZ) |

### Operator commands

```
/cron list                    List all registered jobs
/cron add <json>              Add a new job (see schema below)
/cron remove <id-prefix>      Delete a job
/cron enable <id-prefix>      Enable a disabled job
/cron disable <id-prefix>     Disable without deleting
/cron run <id-prefix>         Fire immediately (manual trigger)
```

**JSON schema for `/cron add`:**

```json
{
  "name": "Weekly review",
  "enabled": true,
  "schedule": { "kind": "cron", "expr": "0 9 * * 1", "tz": "Asia/Shanghai" },
  "payload": {
    "title": "Weekly review",
    "description": "Review the week's progress and plan the next sprint",
    "priority": "normal"
  }
}
```

**Direct payload** (inline action — no task, no container):

```json
{
  "name": "Hello World",
  "enabled": true,
  "schedule": { "kind": "every", "everyMs": 10000 },
  "payload": { "kind": "direct", "message": "Hello World! 👋" }
}
```

Use `kind: "direct"` for lightweight or high-frequency actions (notifications, health pings,
metrics collection). The scheduler executes these inline in the host process — no Docker
containers are spawned. The result is posted as a message to the job's Discord forum thread.

### Files

- `src/cron/types.ts` — `CronJob`, `CronSchedule`, `CronPayload`, `CronJobState` type definitions
- `src/cron/store.ts` — JSON store (read/write jobs, mark fired, delete-after-run, set Discord thread)
- `src/cron/scheduler.ts` — scheduler lifecycle (`startCronScheduler`, `stopCronScheduler`, `reloadCronScheduler`); Discord thread management
- `src/discord.ts` — `createCronJobThread`, `notifyCronJob`, `updateCronJobThreadTitle` exports

---

## Operator Quick Reference

```
/task <description>              Create a new task
/pause --task <id>               Pause task for alignment
/pause --task <id> <message>     Pause + include opening message
/msg --task <id> <message>       Inject a one-off message (no alignment mode)
/done                            End alignment. Agent resumes independently.
/cron list                       List all cron jobs
/cron add <json>                 Add a recurring job (fires a task on schedule)
/cron remove|enable|disable <id> Manage cron jobs
/cron run <id>                   Fire a cron job immediately
```

When in **alignment mode**:
- Type messages directly — no prefix needed.
- Each message is sent to the task's inbox immediately.
- Agent re-launches after each message with full conversation history.
- `/done` ends the conversation and tells the agent to proceed.

---

## Discord Integration

### Mode A — Webhook only (one-way push)

Set `DISCORD_WEBHOOK_URL` in `.env`.

### Mode B — Bot (conversational @mention + slash commands + per-task threads)

Requires `DISCORD_BOT_TOKEN` and `DISCORD_TASKS_CHANNEL_ID`.

**Two-channel architecture:**
- **`#control-plane`** — world events and primary @mention channel
- **`#tasks`** — Forum channel; each task gets its own forum post

**@mention interface:**

```
@LP;HU new task: write a blog post about feature flags
@LP;HU list tasks
@LP;HU status abc12345
@LP;HU pause abc12345 please review the research direction
@LP;HU done
```

The bot uses `@anthropic-ai/claude-agent-sdk` `query()` with per-channel session IDs.
Destructive/creative actions are confirmed before executing.

**Slash commands** (fallback):
```
/new      /tasks     /status <id>     /pause <id>     /msg <id>     /done
```

**Routing logic:**
- World events → webhook → `#control-plane`
- Task progress / alignment → Bot API → task's forum post thread in `#tasks`
- @mention → `messageCreate` event → `handleMention` → Claude SDK loop → reply

**Bot setup:**
1. discord.com/developers/applications → New Application → Bot → Reset Token
2. Enable **Message Content Intent** (Bot page → Privileged Gateway Intents)
3. Invite URL: `https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot+applications.commands&permissions=379968`

**.env:**
```sh
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
DISCORD_BOT_TOKEN=your-bot-token-here
DISCORD_CONTROL_CHANNEL_ID=<control-plane channel id>
DISCORD_TASKS_CHANNEL_ID=<tasks forum channel id>
DISCORD_CRON_CHANNEL_ID=<cron jobs forum channel id>   # optional; enables per-job forum posts
```

### Event routing

| Event | Discord destination |
|---|---|
| World startup | `#control-plane` |
| Task started | `#control-plane` |
| Task progress 📍 | Task's forum post |
| Alignment requested 🤔 | Task's forum post |
| Alignment reply 💬 | Task's forum post |
| Alignment resolved ✅ | Task's forum post |
| Task assigned 📋 | `#control-plane` |
| Task recovery ♻️ | `#control-plane` |
| Cron job created | Cron's forum post (created) |
| Cron job fired ✅/❌ | Cron's forum post (new message) |
| Cron enabled/disabled | Cron's forum post (title updated) |

---

## Why This Model

Orchestration and execution are decoupled:
- runtime technology can evolve (local process, Docker, stronger sandbox)
- operator workflows stay stable (`world/` + `vg`)
- task-level detail remains traceable in dedicated repos

**Repo answers "what happened in execution." World answers "what should the operator do next."**
