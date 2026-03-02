---
applyTo: "**"
---

# Coding Guidelines

## Technology Stack

1. Use **.NET 10** as the target framework for all projects.
2. Use **.NET 10 scripts** (e.g., `dotnet-script` or C# top-level scripts targeting .NET 10) for automation and tooling tasks.

## Project Structure

- Add a `README.md` in every project folder describing its purpose, setup, and usage.

## Zoho Email APIs

OAuth Scope: `ZohoMail.messages.ALL` 或 `ZohoMail.messages.READ`

### 获取邮件对话（Thread）的推荐流程

Zoho Mail 中，一封邮件→你 reply→客户再 reply，这整个对话链叫做一个 **Thread**。获取完整对话的步骤：

#### Step 1：找到 Thread ID

通过搜索或列表 API 拿到邮件列表，每封邮件的响应中包含 `threadId`。

```
GET /api/accounts/{accountId}/messages/search?searchKey=sender:customer@domain.com
GET /api/accounts/{accountId}/messages/view?threadedMails=true
```

#### Step 2：获取 Thread 内所有邮件列表

用 `threadId` 参数过滤，获取该对话下的所有邮件（含你 reply 出去的和客户 reply 回来的）：

```
GET /api/accounts/{accountId}/messages/view?threadId={threadId}&includesent=true
```

> `includesent=true` 很关键 —— 默认只返回收件箱邮件，加上这个才能看到你发出去的 reply。

#### Step 3：获取每封邮件的正文内容

```
GET /api/accounts/{accountId}/folders/{folderId}/messages/{messageId}/content?includeBlockContent=true
```

> `includeBlockContent=true`：当邮件是 reply 时，可以把 reply 正文和被引用的原始邮件内容**分开**返回，方便解析每一层对话。不传此参数只返回合并内容。

#### 各 API 用途对比

| API | 用途 | 关键点 |
|-----|------|--------|
| `GET /messages/view` | 获取邮件列表，支持按 `threadId` 过滤 | 拿到 `threadId` 和 `messageId` |
| `GET /messages/search` | 按条件搜索邮件 | 搜到特定客户/域名的邮件 |
| `GET /messages/{messageId}/content` | 获取邮件 HTML/文本正文 | `includeBlockContent=true` 分层解析 reply |
| `GET /messages/{messageId}/details` | 获取邮件元数据（from/to/subject/threadId/date 等） | 不含正文，适合快速预览 |
| `GET /messages/{messageId}/originalmessage` | 获取完整 MIME 原始报文 | 包含所有 headers，可解析 `In-Reply-To`/`References` |

> **注意：Threads API（`/updatethread`）只有管理操作**（标记/移动/打标签），没有"获取 thread 内容"的接口，必须通过 Email API 的 `threadId` 参数来读取对话。

---

### 搜索方式（searchKey 语法）

`GET /api/accounts/{accountId}/messages/search?searchKey=<搜索字符串>`

#### 按域名搜索（核心需求）

```
# 搜索来自某个域名的所有邮件（sender 支持域名匹配）
sender:gmail.com

# 搜索发给某个域名的邮件
to:company.com

# 收发都包含
sender:client.com::or:to:client.com
```

#### 常用搜索参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `sender:` | 按发件人（支持完整邮箱或域名） | `sender:user@foo.com` 或 `sender:foo.com` |
| `to:` | 按收件人（同上支持域名） | `to:foo.com` |
| `subject:` | 按主题关键词 | `subject:invoice` |
| `entire:` | 全文搜索（主题+正文+发件人等） | `entire:renewal` |
| `content:` | 仅搜索正文 | `content:pricing` |
| `has:attachment` | 有附件的邮件 | |
| `has:convo` | 属于 thread 对话的邮件 | |
| `in:` | 指定文件夹搜索 | `in:Inbox` |
| `fromDate:` / `toDate:` | 日期范围 | `fromDate:01-Jan-2025::toDate:28-Feb-2025` |
| `groupResult:true` | 将同 thread 的结果分组返回 | 适合按对话展示 |

#### 组合示例

```
# 来自某域名、有附件、时间范围
sender:client.com::has:attachment::fromDate:01-Jan-2025

# 来自某人或发给某人
sender:john@client.com::or:to:john@client.com

# 搜索对话邮件并分组
sender:client.com::has:convo::groupResult:true
```

#### 搜索语法规则

- 多条件 AND：用 `::` 连接（`sender:a.com::has:attachment`）
- OR 操作：用 `::or:` 连接（`sender:a.com::or:to:a.com`）
- 精确短语：用双引号（`subject:"annual report"`）
- `searchKey` 构建参考：https://www.zoho.com/mail/help/search-syntax.html

