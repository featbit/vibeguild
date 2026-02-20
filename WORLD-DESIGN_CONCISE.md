# Vibe Guild — World Design (Concise)

## Essence Edition

Vibe Guild is an **autonomous AI operating world** designed to help FeatBit scale vibe marketing with high execution speed and low human coordination overhead.

Instead of a single AI assistant, Vibe Guild runs as a **living universe of AI beings** with role memory, team collaboration, work/rest cadence, escalation rules, and resumable operations. You give a task once; the world keeps moving — and with each task, it becomes slightly more capable than it was before.

> **This world belongs to its Creator.** Beings work autonomously, but sovereignty stays with you. This is the foundational difference between Vibe Guild and "fully autonomous" agent systems that treat the human as a spectator. Every design choice in Vibe Guild is made to ensure that human intervention is natural, immediate, and frictionless: freeze one task, redirect the whole world, inject new requirements mid-execution — the world adapts and continues.

### Core Design Thesis

- **From prompts to operations**: The system is not just "chat + output"; it is a continuous operating loop.
- **From isolated agents to organized teams**: Beings self-organize, split work, elect leaders, and execute using real independent Claude instances — not role-play inside a single context window.
- **From stateless calls to durable memory**: Memory exists at being, team, project, and world levels, with daily/weekly/monthly rollups.
- **From autonomous descent to Creator sovereignty**: Not "let the AI loose and wait." Instead: AI runs at full speed, and the Creator can intervene at any moment — freeze, redirect, resume — with zero friction.
- **From fixed capability to self-evolving knowledge**: After each task, beings distill what they learned into tools and skills that did not exist before. The world compounds.

### Why It Stands Out

1. **Creator sovereignty — the core differentiator**: Most autonomous agent systems default to "set and forget": they execute, you wait, intervention means disruption or restart. Vibe Guild inverts this:
   - **Global meetup**: one command freezes all running tasks; talk to the world in the terminal; change direction; `/done` resumes all from their exact checkpoints.
   - **Task-level meetup**: freeze exactly one World Task; all other tasks keep running uninterrupted.
   - **Soft message injection**: `/msg --task <id>` delivers new instructions to a running leader without interrupting it — absorbed at the leader's next safe stopping point.
   - **Always-readable progress**: `npm run progress -- <taskId>` shows a formatted summary at any time without touching the running runner.
   
   **Intervention is not a concession — it is the Creator's sovereign right. Every layer of the system is built to honour it.**

2. **Shift-based autonomy with soft clock**: 8-minute work + 2-minute rest per day (MVP). Critically: the shift clock fires **soft signals only** — it never pauses or interrupts running tasks. Beings acknowledge rest at their next safe stopping point and keep working.
3. **Multi-horizon memory**: Private self-notes + shared team/project records + world history for cumulative learning.
4. **Dynamic being pool**: The pool starts empty and grows entirely on demand — no upper limit. Free beings are assigned first; new ones are created from a template when capacity is needed. Each being may only work on one task at a time.
5. **Real parallel execution tree**: Each task runs a tree of genuinely independent Claude instances. Being A and Being B execute simultaneously with their own context windows; results flow back to the Leader who coordinates the whole tree. This is not role-play in a shared context — it is real parallel inference.
6. **Self-evolving capability layer**: After task completion, beings reflect: *What did I do repeatedly? What knowledge should exist for the next being?* Skills and tools created during tasks accumulate in `world/shared/` and are promoted into the world engine. Tasks get easier. Beings build on each other's work. The world compounds. *This is the soul of Vibe Guild.*

### Practical Outcome for FeatBit

Vibe Guild is built to continuously produce:

- trend monitoring across developer communities,
- structured insights around feature flags / experimentation / progressive delivery,
- practical application use cases and runnable scenarios for FeatBit,
- tutorials and hands-on guides that reduce adoption friction,
- demos and presentation-ready materials for sales, community, and partnership conversations,
- email sales assets, including outbound sequences, personalized outreach copy, and follow-up templates,
- content assets (blogs, reports, narratives) optimized for SEO and GEO growth,
- and escalation-ready decisions for the human operator.

In short: **an AI-native execution system for consistent marketing output, not one-off AI content generation.**

---

## Concise Edition

Vibe Guild is a persistent AI world for FeatBit marketing:

- **Mission**: turn trend signals into insights and content continuously.
- **Execution model**: subagent tree — each task spawns real independent Claude instances (Leader + Beings) that run in parallel. Not role-play; actual parallel inference.
- **Unit of execution**: dynamic pool of AI beings — starts empty, grows on demand, no upper limit. Free beings are reused first; new ones are created when capacity is needed. One task per being at a time.
- **Cadence**: shift clock fires soft signals only (never interrupts running tasks); beings acknowledge rest at their next safe stopping point.
- **Memory**: being/team/project/world layers + periodic rollups.
- **Creator sovereignty**: global or task-level meetup for freeze/redirect/resume; soft `/msg` for non-interrupting live instruction injection; `npm run progress` for always-on visibility. **Intervention is not a concession — it is the Creator's sovereign right.**
- **Growth loop**: after each task, beings write skills and tools that did not exist before — accumulated in `world/shared/`, promoted world-wide. Every task leaves the world more capable.

**One-line pitch**: *Vibe Guild runs autonomously — but the world always belongs to its Creator. Intervene at any moment, from any angle; the world adapts and continues.*
