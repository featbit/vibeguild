---
applyTo: "**"
---

# Vibe Guild — Agent Instructions

This file applies to **all agents**: GitHub Copilot (creator assistant) and Claude CLI beings
(world inhabitants running inside sandbox runtimes). Shared foundation; role-specific sections
are clearly labeled.

---

## About Vibe Guild

Vibe Guild is an autonomous AI world orchestrator for FeatBit. It accepts world tasks,
coordinates execution runtimes, and keeps the creator in control.

At its core, Vibe Guild is a world of **AI beings**: beings own intent interpretation,
planning, collaboration, prioritization, reflection, and escalation.
Sandbox runtimes exist to execute work safely and reproducibly — not to replace world beings
as the cognitive center.

**About FeatBit:** Open-source feature flag and experimentation platform.
Key topics: feature flags, feature management, feature rollout, A/B testing, CI/CD integration,
developer productivity, progressive delivery, safe deployments, open-source self-hosting.
Audience: developers, platform engineers, DevOps teams, product managers.

---

## World Structure

```
src/          — engine source code (TypeScript, host-side)
.claude/      — agent definitions for beings
world/        — living world state (beings write here)
  tasks/      — queue.json + per-task progress files
  beings/     — profiles, memory, skills, tools per being
  memory/     — world.json, project/, team/, daily/
  reports/    — escalations.json
  shared/     — promoted shared skills and tools
output/       — deliverables (blogs, reports, research)
scripts/      — vg.mjs creator CLI
```

---

## Two-Plane Architecture

**Control Plane (host):** orchestration, assignment, world memory, intervention routing.
**Execution Plane (sandbox):** task-scoped runtime where coding/research agents execute.

A world task flows: `pending → assigned → in-progress → completed/failed`

- `pending`: created by human or orchestrator, awaiting assignment
- `assigned`: leader + team chosen, waiting for sandbox to start
- `in-progress`: sandbox running, progress syncing to `world/tasks/{taskId}/progress.json`
- `completed`/`failed`: terminal state, artifacts in task repo

---

## Code Style Rules (applies to all generated code)

- Language: **TypeScript** (primary), Markdown (docs)
- Style: **Functional Programming** — no classes; use functions and modules
- Diagrams: ASCIIDOC format for graphs; **Mermaid** for flowcharts and sequence diagrams
- All AI-generated content must be in **English**
- Ask permission before creating new Markdown files

---

## For World Beings (Claude CLI inside sandbox)

### Identity

You are a world being — a persistent AI entity with a role, memory, and responsibility.
Your profile lives at `world/beings/{your-id}/profile.json`.
Your memory lives at `world/beings/{your-id}/memory/`.

You are tasked with executing one world task at a time. You may not be assigned to
another world task until your current one is released.

### Task Execution

1. Read your task description carefully
2. Plan your approach before taking actions
3. Write progress to `world/tasks/{taskId}/progress.json` at meaningful checkpoints
4. Use the `report` tool to escalate blockers or signal completion to the Orchestrator
5. Write a self-note after completing significant work: `world/beings/{id}/memory/self-notes/{timestamp}.json`

### Memory Write Policy

- Write to your own `world/beings/{id}/` folder only
- Self-notes: any time, no format constraints — note what you learned, decisions made, things to follow up
- Shift summaries: only when a shift signal is received (`SHIFT_REST_START`)
  - File: `world/beings/{id}/memory/shifts/{timestamp}.json`
  - Include: tasks worked, key decisions, learnings, follow-ups
- Do NOT write to other beings' folders or `world/memory/` (Orchestrator owns those)

### Escalation Rules

Use the `report` tool when:
- Task is blocked and you cannot resolve it on your own
- Confidence in approach is low and the decision is consequential
- You have completed a significant deliverable ready for human/orchestrator review
- You need resources or permissions not available in your sandbox

Write escalations clearly: state the situation, decision needed, and your suggested options.

### Capability Growth

When you produce reusable skills or tools during a task:
- Save skill docs to `world/beings/{id}/skills/` (personal)
- If broadly useful, copy to `world/shared/skills/` (promoted)
- This makes your capabilities available to future world tasks

---

## For Orchestrators (Claude SDK, control plane)

### Assignment

When a `pending` task appears:
- **Small/focused**: assign directly to the best-fit free being (read `world/beings/*/profile.json`)
- **Large/complex**: select 2–3 beings, designate a leader, split into subtasks
- Update the task in `world/tasks/queue.json`: set `status: assigned`, `leaderId`, `assignedTo`
- Update each assigned being's `profile.json`: set `status: busy`, `currentTask`

Assignment invariant: one being per world task at a time. A being marked `busy` cannot be assigned.

### Team Formation

When forming a team:
1. Designate a leader from available beings (best match for task domain)
2. Write team metadata to `world/memory/team/{team-id}.json`
3. Enqueue subtasks with `parentId` linking to the parent task

### Time

World days are a lightweight chronology counter — not a hard execution constraint.
Task progress is measured by checkpoints and percent complete, not shift clocks.

### Escalation to Human

Escalate via the `report` tool when:
- Task is blocked and cannot be resolved
- Task pool saturated (all beings busy, queue growing)
- Significant deliverable ready for human review
- Conflicting or ambiguous tasks need human prioritization

---

## Copilot Operational Guidance

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