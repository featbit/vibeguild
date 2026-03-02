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

**API Base URL:** `https://mail.zoho.com`

**Official Documentation:**
- Email API overview: https://www.zoho.com/mail/help/api/email-api.html
- List emails: https://www.zoho.com/mail/help/api/get-emails-list.html
- Search emails: https://www.zoho.com/mail/help/api/get-search-emails.html
- Get email content: https://www.zoho.com/mail/help/api/get-email-content.html
- Get email metadata: https://www.zoho.com/mail/help/api/get-email-meta-data.html
- Get original message (MIME): https://www.zoho.com/mail/help/api/get-original-message.html
- Threads API: https://www.zoho.com/mail/help/api/threads-api.html
- Search syntax reference: https://www.zoho.com/mail/help/search-syntax.html

OAuth Scope: `ZohoMail.messages.ALL` or `ZohoMail.messages.READ`

### Recommended Flow for Fetching Email Conversations (Threads)

In Zoho Mail, the full conversation chain — original email → your reply → customer reply — is called a **Thread**. Steps to retrieve a complete conversation:

#### Step 1: Find the Thread ID

Fetch the email list via search or list API. Each email in the response includes a `threadId`.

```
GET /api/accounts/{accountId}/messages/search?searchKey=sender:customer@domain.com
GET /api/accounts/{accountId}/messages/view?threadedMails=true
```

#### Step 2: Get All Emails Within the Thread

Filter by `threadId` to retrieve every message in the conversation, including your sent replies:

```
GET /api/accounts/{accountId}/messages/view?threadId={threadId}&includesent=true
```

> `includesent=true` is critical — by default only inbox emails are returned. This parameter includes emails you sent as replies.

#### Step 3: Fetch the Body of Each Email

```
GET /api/accounts/{accountId}/folders/{folderId}/messages/{messageId}/content?includeBlockContent=true
```

> `includeBlockContent=true`: When the email is a reply, this separates the reply body from the quoted parent content, allowing you to parse each layer of the conversation individually. Without this parameter, the content is returned as a single merged block.

#### API Reference Summary

| API | Purpose | Key Notes |
|-----|---------|-----------|
| `GET /messages/view` | List emails, filterable by `threadId` | Returns `threadId` and `messageId` |
| `GET /messages/search` | Search emails by conditions | Find emails from a specific customer or domain |
| `GET /messages/{messageId}/content` | Get email HTML/text body | Use `includeBlockContent=true` to parse reply layers |
| `GET /messages/{messageId}/details` | Get email metadata (from/to/subject/threadId/date) | No body content; useful for quick previews |
| `GET /messages/{messageId}/originalmessage` | Get full MIME raw message | Contains all headers; parse `In-Reply-To`/`References` |

> **Note: The Threads API (`/updatethread`) only provides management operations** (flag, move, label). There is no dedicated "get thread content" endpoint — use the Email API with the `threadId` parameter to read conversations.

---

### Search Options (searchKey Syntax)

`GET /api/accounts/{accountId}/messages/search?searchKey=<search string>`

#### Search by Domain

```
# Emails from a specific domain (sender supports domain matching)
sender:gmail.com

# Emails sent to a specific domain
to:company.com

# Both sent and received
sender:client.com::or:to:client.com
```

#### Common Search Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `sender:` | Filter by sender (full email address or domain) | `sender:user@foo.com` or `sender:foo.com` |
| `to:` | Filter by recipient (same, supports domain) | `to:foo.com` |
| `subject:` | Search by subject keyword | `subject:invoice` |
| `entire:` | Full-text search (subject + body + sender, etc.) | `entire:renewal` |
| `content:` | Search body text only | `content:pricing` |
| `has:attachment` | Emails with attachments | |
| `has:convo` | Emails that are part of a thread conversation | |
| `in:` | Search within a specific folder | `in:Inbox` |
| `fromDate:` / `toDate:` | Date range filter | `fromDate:01-Jan-2025::toDate:28-Feb-2025` |
| `groupResult:true` | Group results from the same thread together | Useful for conversation-style display |

#### Combination Examples

```
# From a domain, with attachment, within a date range
sender:client.com::has:attachment::fromDate:01-Jan-2025

# From or to a specific person
sender:john@client.com::or:to:john@client.com

# Conversation emails, grouped by thread
sender:client.com::has:convo::groupResult:true
```

#### Syntax Rules

- AND (multiple conditions): use `::` — e.g. `sender:a.com::has:attachment`
- OR: use `::or:` — e.g. `sender:a.com::or:to:a.com`
- Exact phrase: use double quotes — e.g. `subject:"annual report"`
- Full searchKey reference: https://www.zoho.com/mail/help/search-syntax.html

