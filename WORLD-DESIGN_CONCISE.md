# LP;HU — World Design (Concise)

## Core Definition

LP;HU is an AI team execution system for FeatBit, not a single-agent chat assistant.

It is designed to automate the loop:

`skill authoring → skill validation → skill-triggered demo → best-practice output`

while staying human-in-the-loop friendly at every critical decision point.

---

## Team-First Operating Model

At startup, LP;HU initializes a default AI team in `world/teams/active.json`:

- `TeamLead` (overall owner)
- `Builder`
- `Verifier`
- `NarrativeEngineer`
- `OperatorLiaison`

Each task keeps explicit ownership metadata:

- `leadRole`
- `assignedRoles`

Control plane is CLI-first (Copilot CLI + Copilot SDK). Role identity is represented in world state and task metadata.

---

## Lifecycle Model

LP;HU now uses two complementary status layers:

1. **Runtime control state** (`pending`, `assigned`, `in-progress`, `blocked`, `completed`, `failed`, `escalated`)
2. **Delivery semantic state** (`not_started`, `in_progress`, `temp_done`, `fully_done`)

This separates execution mechanics from business-level completion quality.

---

## Task Taxonomy (MVP)

`taskKind` values:

- `demo`
- `dev_insight_blog`
- `learning_note`
- `issue_feedback`
- `skill_validation`
- `skill_demo_trigger`

Kinds can be inferred automatically from task text and can also be set explicitly.

---

## Collaboration and HITL

The team runs continuously (plan, build, run/test, summarize, report), and the operator can intervene at any moment.

Every task is preflight-gated: before execution starts, the team must publish a plan and wait in `waiting_for_human` until the operator explicitly approves.

Persistent alignment memory is recorded per task:

- `world/alignment/<taskId>/history.ndjson`

Stored events include:

- agent questions,
- operator replies,
- pause requests,
- resume decisions,
- alignment status transitions.

This ensures every alignment conversation is recoverable and auditable.

---

## World Folder Evolution

Added without breaking existing runtime contracts:

- `world/teams/active.json`
- `world/alignment/<taskId>/history.ndjson`
- `world/demos/*`, `world/examples/*`, `world/insights/*` (category workspaces)

Existing core contracts remain:

- `world/tasks/queue.json`
- `world/tasks/<taskId>/progress.json`
- `world/shared/*`

---

## One-Line Pitch

LP;HU is an AI team that delivers continuously, aligns with humans in real time, and keeps decisions in durable memory.
