# Vibe Guild — White Paper

> **LP;HU — Low Polish, High Utility**
>
> 这不是一个浮夸的 AI 世界。这是一个笨人为自己造的实用工具。
>
> This is not a fancy AI world. This is a practical tool built by a dumb person, for a dumb person.

---

## 核心立场 / Core Stance

**中文**

我不需要会自我进化的 AI 生灵，不需要花里胡哨的世界观。我需要的是：**一个通用 agent 框架作为底座，加上在我的准确监督下运行的垂直 agent 能力**。

这个项目的第一原则是：**实用优先，过早优化是万恶之源。**

**English**

I don't need self-evolving AI beings, no elaborate world metaphors. What I need is: **a general-purpose agent framework as the foundation, plus vertical agent capabilities running under my accurate supervision**.

The first principle of this project is: **utility first; premature optimization is the root of all evil.**

---

## 架构本质 / Architectural Reality

**中文**

Vibe Guild 本身是一个**通用 agent 框架**——它可以接受任意任务、调度执行、管理上下文。但它的每一项具体能力，都通过**垂直 agent + 大量 human-in-the-loop** 来保证完整性和准确性。

这两层架构缺一不可：

- **通用框架层**：负责任务调度、上下文持久化、工具注册、对齐机制。这一层越薄越好，不要在这里堆业务逻辑。
- **垂直能力层**：每个具体任务（写 blog、监控社区、生成代码示例）都作为一个独立的垂直 agent 执行，配以准确、及时的人工介入来保证质量。

瓶颈永远不是 AI 能力，而是**人对任务的总结性表达能力**。长时间不介入，agent 在 plan 阶段和实现阶段都会偏离你的真实意图。通用框架解决不了这个问题，只有及时的 human-in-the-loop 才能解决。

**English**

Vibe Guild itself is a **general-purpose agent framework** — it accepts arbitrary tasks, schedules execution, and manages context. But each concrete capability within it is guaranteed by **vertical agents + heavy human-in-the-loop**.

These two layers are both essential:

- **General framework layer**: handles task scheduling, context persistence, tool registration, and alignment mechanisms. Keep this layer thin — don't pile business logic here.
- **Vertical capability layer**: each specific task (writing blogs, monitoring communities, generating code samples) runs as an isolated vertical agent, paired with accurate and timely human intervention to ensure quality.

The bottleneck is never AI capability. It's **the human's ability to express intent clearly**. Leave it alone too long, and the agent drifts from your actual goal in both the planning and execution phases. A general framework can't fix this — only timely human-in-the-loop can.

---

## 什么是 Vibe Guild / What Is Vibe Guild

**中文**

Vibe Guild 是一个由**垂直 agent** 组成的任务执行框架，专为帮助 FeatBit 完成 vibe marketing 工作而构建：

- 在 Reddit、Hacker News、指定链接中持续监控 feature flag、feature management、AI coding 等相关内容，提炼 insights 和 trends
- 理解并分解我发布的任务，制定计划，执行，**过程中及时汇报**，不是做完了再说
- 通过 MCP、Skills、CLI 工具组合完成工作，不自己造轮子

任务的核心循环是：**我发布任务 → agent 执行 → 我在关键节点介入校正 → agent 继续**。

**English**

Vibe Guild is a **vertical-agent task execution framework** built specifically to help FeatBit with vibe marketing work:

- Continuously monitor Reddit, Hacker News, and designated sources for content related to feature flags, feature management, and AI coding; extract insights and trends
- Understand and decompose tasks I publish, plan, execute, and **report at key checkpoints during execution** — not after
- Accomplish work through MCP, Skills, and CLI tooling — no reinventing wheels

The core loop is: **I publish a task → agent executes → I step in at key points to correct → agent continues.**

---

## Human-in-the-Loop 是核心机制，不是可选项 / HITL Is the Core, Not Optional

**中文**

Agent 在两个阶段最容易偏离：

1. **Plan 阶段**：对任务的理解和拆解可能跑偏
2. **实现阶段**：执行路径可能偏离真实意图

解决方法不是让 AI 更聪明，而是**让人的介入更精准、更及时**。Vibe Guild 的对齐机制（pause / alignment flow）正是为此而设计的。

**English**

Agents most commonly drift in two phases:

1. **Planning phase**: task interpretation and decomposition goes off-track
2. **Execution phase**: the implementation path diverges from actual intent

The fix is not making AI smarter. It's **making human intervention more precise and timely**. The alignment mechanism in Vibe Guild (pause / alignment flow) is designed exactly for this.

---

## 演进策略 / Evolution Strategy

**中文**

- **SKILL 文件驱动演进**：能力的更新通过更新 SKILL.md 并重跑 coding agent 完成，不依赖运行时自学习
- **不优化现在模型的弱点**：等 6–18 个月后更强的模型出来，自然解决
- **保持简单**：只加对我当下有用的东西

**English**

- **SKILL-file-driven evolution**: capability updates happen by editing SKILL.md files and re-running the coding agent — no runtime self-learning required
- **Don't patch today's model weaknesses**: stronger models in 6–18 months will handle this naturally
- **Stay simple**: only add what is useful to me right now

---

## 关于 AI 的立场 / My Stance on AI

**中文**

我反对降临派——他们看上去比大多数笨人还笨。但我期待 AI 真正解放人类从无意义劳动中抽身的那一天。

在那天到来之前，我选择做一个清醒的笨人：用准确的人工监督，驱动实用的垂直 agent，完成真实的工作。

**English**

I oppose AI accelerationism — they seem even less thoughtful than most ordinary people. But I look forward to the day AI genuinely frees humans from meaningless labor.

Until then, I choose to be a clear-headed dumb person: using accurate human supervision to drive practical vertical agents to do real work.

---

*LP;HU — Low Polish, High Utility.*
