---
applyTo: "**"
---

# Vibe Guild — Agent Instructions

This file applies to **all agents**: GitHub Copilot (creator assistant) and Claude CLI beings
(world inhabitants running inside sandbox runtimes). Shared foundation; role-specific sections
are clearly labeled.

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

## For World Beings (Claude CLI inside sandbox)

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

When the human asks for world runtime visibility (task queue, progress, escalations, status),
prefer the `vg` CLI first, then summarize the result.

Preferred commands:

```sh
node scripts/vg.mjs overview
node scripts/vg.mjs tasks
node scripts/vg.mjs tasks <status> [limit]
node scripts/vg.mjs progress <taskId-or-prefix>
node scripts/vg.mjs escalations [limit]
```

Fallback policy:

1. Try `scripts/vg.mjs` first for low-token, operator-friendly output
2. Only read raw files under `world/` when CLI output is insufficient
3. Keep summaries concise and action-oriented for the creator

---

## Operator Workflow (for Copilot — guide the creator through these steps)

### Starting the world

```sh
npm start
```

All operator commands (`/task`, `/pause --task`, etc.) must be typed into **this same terminal**
— not a separate PowerShell window.

### Managing MCP tools and shared skills

Use a **separate terminal** for setup operations:

```sh
npm run setup
```

`npm run setup` is the only operator flow for world-shared MCP/tool and skill management
(add/list/remove + MCP connection test).

- Do **not** add/remove MCP or skills from the `npm start` world command console.
- Changes are persisted to `world/shared/` and apply to **new** sandbox tasks.

### Creating a task

```
/task <description>
```

Wait for `📋 Task added: <uuid>` and then `🚀 [World] Starting runner` before issuing any
`/pause` command. The task ID prefix (first 8 chars) is used in all follow-up commands.

### Testing / using the alignment flow

1. Create a task and wait for the first `📍` progress line.
2. Issue a pause:
   ```
   /pause --task <id-prefix> <optional opening message>
   ```
3. Within ~2 seconds the container's Claude process is killed via `pause.signal` + SIGTERM
   (no LLM cooperation needed). You'll see:
   ```
   📍 [leader→<id>] … — Paused by creator for alignment
   🤔 [leader→<id>] Leader needs your input:
      "<context from pause message>"
      ► Type your reply (press Enter to send). Type /done to let leader proceed independently.
   ```
4. Type messages directly — no prefix. Each message is sent to the task inbox and Claude is
   re-launched with the full conversation history.
5. Blake/Casey will **always** acknowledge first (write `waiting_for_human` with their
   understanding + plan), then ask "Shall I proceed?". You'll see their reply as:
   ```
   💬 [leader] <acknowledgment + updated plan>
      ► Your reply:
   ```
6. Reply to refine further, or type `/done` to let the leader proceed independently.

### Common mistakes to avoid

- **Do NOT** type `/pause --task` in a separate PowerShell window — it must be in the `npm start` terminal.
- **Do NOT** issue `/pause --task` before the first `📍` appears — the container may not be running yet.
- **Do NOT** run `/task` or `/pause` inside the `npm run setup` terminal; setup terminal is only for MCP/skill configuration.
- If alignment resolves immediately without a `🤔` prompt, it means the previous Claude process
  had already written `in-progress` before the signal arrived. Just issue `/pause --task` again
  on the same task — it re-enters alignment mode.
- `/done` ends alignment and tells the leader to proceed on its own judgment.