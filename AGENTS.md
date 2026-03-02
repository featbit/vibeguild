---
applyTo: "**"
---

# LP;HU — Agent Instructions

This file applies to **all agents**: GitHub Copilot (operator assistant) and Claude CLI agents
(running inside sandbox containers). Shared foundation.

---

## Good Habbit

Everytime you finished a change, you should also at least update WORLD-DESIGN.md. You should also consider to update README.md if the change is related to operator workflows or commands.

---

## Code Style Rules (applies to all generated code)

- Language: **TypeScript** (primary), Markdown (docs)
- Style: **Functional Programming** — no classes; use functions and modules
- Diagrams: ASCIIDOC format for graphs; **Mermaid** for flowcharts and sequence diagrams
- All AI-generated content must be in **English**
- Ask permission before creating new Markdown files

---

## For Sandbox Agents (Claude CLI inside Docker container)

### Output storage

Each task's output files are stored under `/workspace/output/` inside the container.
On the host this maps to `output/{taskId}/` — outputs are **isolated per task**, not shared.
Write all deliverables (drafts, reports, data files, etc.) to `/workspace/output/`.

### GitHub repo — the persistent workspace

Every world task has a corresponding GitHub repository that is **its primary persistent
workspace**. Treat the repo as the authoritative record of the task's work.

**Mandatory practices:**

1. **Clone / set up the repo** at the start of execution.
2. **Commit intermediate results continuously** — after every meaningful milestone (draft,
   analysis, fetched data, partial implementation, etc.). Do NOT wait for the task to finish.
3. **Commit final results** and all output artifacts before writing `status: "completed"`.
4. **Update README.md** in the repo root at task completion:
   - Add or update a `## Results` section listing what was produced.
   - Include file paths, one-line descriptions, and any key URLs or findings.
   - Commit and push this as the final action.
5. Keep the `runtime-details/{taskId}/` folder synced (claude-code.log,
   progress-snapshots.ndjson, artifacts-manifest.md) — push repeatedly, not only at the end.

**Why:** Docker containers are ephemeral. If results exist only in `/workspace/output/`
but not in the GitHub repo, they are lost on container restart. The repo is how future
sessions, task continuations, and resumes recover prior work.

---

### Copilot Operational Guidance

**Copilot Chat is the control plane.** Use natural language — Copilot reads `world/` files
and runs `vg` scripts to query state and issue commands.

#### Read state (vg.mjs)

```sh
node scripts/vg.mjs overview
node scripts/vg.mjs tasks
node scripts/vg.mjs tasks <status> [limit]
node scripts/vg.mjs progress <taskId-or-prefix>
node scripts/vg.mjs escalations [limit]
```

Fallback: read raw files under `world/` when CLI output is insufficient.

#### Write / control (vg-write.mjs)

```sh
# Add a task to the queue
node scripts/vg-write.mjs add-task "<description>" [--priority normal|high|low|critical] [--title "<title>"]

# Send a message to a running task (alignment reply, instruction)
node scripts/vg-write.mjs inject-message <taskId> "<message>"

# Request alignment — kills Claude immediately via pause.signal, waits for input
node scripts/vg-write.mjs pause-task <taskId> ["<opening message>"]

# Resume a frozen task or the whole world
node scripts/vg-write.mjs resume [--task <taskId>]

# Re-queue a completed/failed task with feedback
node scripts/vg-write.mjs revise <taskId> "<feedback>"
```

---

## Operator Workflow (for Copilot)

### Execution modes

| Mode | Start | Best for |
|------|-------|---------|
| **Docker sandbox** | `npm start` in a terminal | Long-running, isolated, automated tasks |
| **Copilot Background** | `copilot` CLI (background session) | Interactive, local, real-time collaboration |
| **Copilot Cloud** | `/delegate` inside Copilot CLI | Async, tangential tasks, creates a PR |

The `world/` task queue and `world/tasks/{id}/` state files are the shared data layer.
`npm start` manages docker sandbox lifecycle; Background/Cloud agents use Copilot's own session state.

### Starting the docker sandbox world

```sh
npm start
```

The scheduler picks up `pending` tasks every 5 s and starts docker containers automatically.
Monitor progress via `node scripts/vg.mjs overview`.

### Creating a task (docker sandbox)

```sh
node scripts/vg-write.mjs add-task "Build a demo for feature X" --priority high
```

Or via the CLI subcommand (same result):

```sh
node dist/world.js task "Build a demo for feature X" --priority high
```

Watch for `🚀 [World] Starting runner` in the `npm start` terminal.
The task ID prefix (first 8 chars) is used in all follow-up commands.

### Alignment flow

1. Wait for `🤔 [task:<id>] Agent needs input:` in the world terminal, OR proactively pause:
   ```sh
   node scripts/vg-write.mjs pause-task <id-prefix> "Optional opening message"
   ```
2. Watch the world terminal for `🤔` — Claude is now waiting.
3. Send replies:
   ```sh
   node scripts/vg-write.mjs inject-message <id-prefix> "Your reply here"
   ```
4. The agent acknowledges with `waiting_for_human` + a plan. Continue the dialogue or let it proceed:
   ```sh
   node scripts/vg-write.mjs inject-message <id-prefix> "Looks good, proceed"
   ```

### Skills and MCP

Skills and MCP configs live in the standard host-side locations — **not** duplicated in `world/`:

| Location | Used by |
|----------|---------|
| `~/.claude/plugins/…` | Docker sandbox (auto-mounted) |
| `~/.agent/` | Docker sandbox (mounted if `AGENT_HOME_HOST_PATH` is set) |
| `~/.copilot/` | Copilot CLI reads natively |
| `.github/copilot-instructions.md` | Copilot CLI reads natively |
| `AGENTS.md` | Both Copilot CLI and docker sandbox |

Docker sandbox paths are configurable via env vars:
- `FEATBIT_SKILLS_HOST_PATH` — defaults to `$HOME/.claude/plugins/marketplaces/featbit-marketplace/skills`
- `AGENT_HOME_HOST_PATH` — defaults to `$HOME/.agent` (only mounted if non-empty)

### Discussion sessions

Each operator–Copilot discussion is persisted in `world/discussions/`.

```
world/discussions/
  {id}.md        # one file per discussion thread
```

File format (frontmatter + body):

```markdown
---
id: <uuid>
status: open | parked | resolved
topic: "<short topic label>"
created: <ISO date>
---

## Summary
<Running summary — updated as the discussion evolves>

## Key Decisions
- …

## Open Questions
- …

## Next Step
<What happens after this discussion>
```

**Workflow:**
1. When a new topic arises, check `world/discussions/` for an existing open or parked thread on the same subject. If found, resume it.
2. Create a new `{id}.md` when starting a fresh discussion.
3. Update the file at each meaningful checkpoint (decision made, question answered, direction changed).
4. Set `status: parked` when pausing mid-discussion; `status: resolved` when the thread reaches a conclusion.

Copilot reads and writes these files directly — no separate tool needed.