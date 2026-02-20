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
   - During execution, beings can produce skill artifacts in the task repo.
   - At stage boundaries, selected skills are synchronized back into world-level skill memory.
   - This preserves individual growth and enables cross-task reuse for future teams.

## Runtime Model

### High-Level Architecture (ASCII)

```text
                         +----------------------------------+
                         |     Creator / Operator Console   |
                         |   (vg CLI, meetup, inject msg)   |
                         +----------------+-----------------+
                                          |
                                          v
+-----------------------------------------------------------------------+
|                    Control Plane (Host Orchestrator)                  |
|  - assignment / scheduling / escalation                               |
|  - task lifecycle + intervention routing                              |
|  - AI beings collaboration + world memory decisions                   |
|  - world summary sync (`world/tasks/*/progress.json`)                |
+------------------------------+----------------------------------------+
                               |
               per world task  | runtime adapter boundary
                               v
         +----------------------------------------------------+
         |        Execution Plane (Sandbox Runtime)           |
         |  - leader being runtime instance                  |
         |  - member beings runtime instances                |
         |  - coding/research actions under leader guidance  |
         |  - task-scoped repo + artifacts + event outbox     |
         +------------------------+---------------------------+
                                  |
                                  v
                   +-------------------------------+
                   | Task GitHub Repo + Artifacts  |
                   | (execution-level truth)       |
                   +-------------------------------+
```

### Control Plane (Host)

The host orchestrator is responsible for:
- queue assignment and team/leader selection,
- world task lifecycle state,
- escalation handling,
- creator meetup and live intervention,
- syncing task summaries into `world/`.

Within this plane, AI beings provide:
- task understanding and decomposition,
- collaborative decision-making across related world tasks,
- memory-aware planning using world/project/team context,
- reflective learning and capability growth.

It does **not** need to execute all coding/research commands directly.

### Execution Plane (Sandbox)

Each world task can run in a dedicated sandbox runtime (for example, a Docker container)
with task-scoped resources.

Typical sandbox responsibilities:
- run assigned world beings as task-scoped runtime instances,
- execute coding/research workflows under team leader coordination,
- write detailed execution artifacts,
- track reliable event outbox for resume/recovery.

Identity model:
- every world task has one team (leader + members),
- the same team decides in control-plane context,
- the same team executes in sandbox context via runtime instances,
- leader remains responsible for coordination, quality bar, and escalation across both planes.

Assignment invariants:
- a single `beingId` can belong to only one world task at a time (task-level exclusivity),
- once assigned, that being is considered `busy` and cannot be assigned to another world task,
- inside the same world task, that being may run multiple execution rounds/steps in sandbox runtime,
- the being returns to `idle` only after release/completion/abort handling for that world task.

Sandbox runtime can be task-scoped to a dedicated GitHub repository.

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
                | produce skill artifacts
                v
      +---------------------------------------------+
      | Task Repo (stage-scoped skills and notes)   |
      +------------------------+--------------------+
                |
                | stage-boundary sync
                v
      +---------------------------------------------+
      | World Skill Memory                           |
      | - world/beings/{id}/skills/ (personal)      |
      | - world/shared/skills/ (shared/promoted)    |
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
   | Task Repo + Runtime Artifacts               |
   | - commits / diffs / tests / logs            |
   | - task status internals / checkpoints       |
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

### Execution-facing state (task repo + artifacts)

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
- candidate skill artifacts from task repo,
- being-level skill updates (`world/beings/{id}/skills/`),
- optional promoted shared skills (`world/shared/skills/`),
- metadata linking skill origin to task/repo/checkpoint.

This contract enables low-token operator monitoring with `vg` and keeps
cross-task reuse available to future work.

## Intervention Model

### Intervention Flow (ASCII)

```text
Creator Action
   |
   +--> Pause task ----------> Control Plane ----------> Sandbox Runtime (pause)
   |
   +--> Resume task ---------> Control Plane ----------> Sandbox Runtime (resume)
   |
   +--> Inject instruction --> Control Plane ----------> Task inbox/runtime adapter
   |
   +--> Request checkpoint --> Control Plane ----------> Sync to world progress
```

Intervention remains first-class:
- pause / resume task,
- inject instruction,
- request checkpoint,
- escalate to creator.

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
