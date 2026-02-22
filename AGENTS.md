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