---
name: get-task-details
description: Read a task's current status, progress, logs, and output files. Use this skill whenever the operator asks about a specific task — its status, what it produced, recent progress, or error details.
---

# Get Task Details

Use when the operator mentions a task ID prefix (8 chars) or asks about a running/completed task.

## Step 1 — Resolve the full UUID

Task IDs displayed in Discord are 8-char prefixes. Resolve to the full UUID:

```bash
ls world/tasks/ | grep <8-char-prefix>
```

## Step 2 — Read task state

```bash
# Core task metadata (status, leader, title, revisionNote, etc.)
cat world/tasks/<full-uuid>/task.json
```

Key fields to surface to the operator:
- `status`: `pending | in-progress | completed | failed | paused`
- `title`: brief task description
- `leader`: which being is running it (blake / casey / aria)
- `revisionNote`: last revision instruction (if any)

## Step 3 — Read recent progress

```bash
# Latest progress snapshot (last line = most recent)
tail -5 world/tasks/<full-uuid>/progress-snapshots.ndjson 2>/dev/null || echo "(no snapshots yet)"
```

## Step 4 — List output files

```bash
# Task outputs land in output/<uuid>/
ls output/<full-uuid>/ 2>/dev/null || echo "(no output yet)"
```

## Step 5 — Read notable outputs

```bash
# Start with README and any .md files
cat output/<full-uuid>/README.md 2>/dev/null
```

## Summarising for the operator

Report back:
1. Task title + status (+ leader)
2. Most recent progress line (what is the being doing right now?)
3. Output files produced (file names + one-liner descriptions)
4. Any blockers or revision notes

Keep the summary concise — bullet points, no excessive quoting.
