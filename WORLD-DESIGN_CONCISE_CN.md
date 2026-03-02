# LP;HU — 世界设计（精炼版）

## 核心定义

LP;HU 是一个面向 FeatBit 的 AI 团队执行系统，不是单个 Agent。

系统目标：持续自动化完成 `skills 触发 demo → 基于 demo 验证 skills → 最佳实践产出` 的闭环，并且始终 human-in-the-loop 友好。

---

## 团队模型（默认初始化）

系统启动时自动初始化一支 AI 团队（`world/teams/active.json`）：

- `TeamLead`（总负责人）
- `Builder`
- `Verifier`
- `NarrativeEngineer`
- `OperatorLiaison`

说明：

- 一个角色默认对应一个 agent 身份（可在后续阶段细化为 sub-agent 树）。
- 控制面采用 CLI-first（Copilot CLI + Copilot SDK）；角色身份体现在系统状态与消息语义里。

---

## 任务生命周期（双状态视图）

### 运行状态（queue）

沿用运行控制需要的状态：`pending / assigned / in-progress / blocked / completed / failed / escalated`。

### 交付语义状态（completionLevel）

新增统一语义层：

- `not_started`
- `in_progress`
- `temp_done`
- `fully_done`

这样可以区分“机器运行结束”与“业务上真正完成”。

---

## 任务类型（MVP）

新增标准任务类型（`taskKind`）：

- `demo`
- `dev_insight_blog`
- `learning_note`
- `issue_feedback`
- `skill_validation`
- `skill_demo_trigger`

任务默认自动推断类型，也可显式指定。

---

## 协同与对齐机制

### AI 团队协同

每个任务保留：

- `leadRole`（默认 TeamLead）
- `assignedRoles`（默认全角色）

团队协同按“计划 → 实现 → 验证 → 汇报”推进，运行中通过 checkpoints 持续对外同步。

### 人机对齐（HITL）

每个任务在真正执行前都必须先做一次计划对齐：团队先产出计划并进入 `waiting_for_human`，只有在你明确同意后才开始执行。

执行过程中如果出现新的不确定点，仍可再次进入 `waiting_for_human`；你可以持续给建议，或 `/done` 让团队自主继续。

新增持久化对齐记忆：

- 路径：`world/alignment/<taskId>/history.ndjson`
- 记录：`agent` 问题、`operator` 回复、`pause_request`、`resume`、状态恢复事件

这让“我们讨论过什么、为什么这样做”可追踪、可复盘。

---

## 世界目录重构（增量）

在不破坏现有运行路径前提下，新增：

- `world/teams/active.json`：当前 AI 团队定义与负责人
- `world/alignment/<taskId>/history.ndjson`：任务级对齐历史
- `world/demos/*`、`world/examples/*`、`world/insights/*`：按任务类型分类的工作结果目录

保留现有：

- `world/tasks/queue.json`（运行控制）
- `world/tasks/<taskId>/progress.json`（执行进度）
- `world/shared/`（共享工具与技能）

---

## 操作视图（你能看到什么）

`vg` / `status` 输出会逐步聚焦以下关键字段：

- task status + completion level
- task kind
- team lead / role
- 对齐中的最新上下文

目标是：你不用翻原始日志，也能判断该不该介入、该怎么介入。

---

## 一句话

LP;HU 不是“单 agent 自动跑”，而是“AI 团队持续交付 + 人类随时对齐 + 记忆可追溯”的工程系统。
