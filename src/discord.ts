/**
 * discord.ts — Discord integration for Vibe Guild.
 *
 * Uses discord.js for:
 *   - Gateway WebSocket connection (receives slash command interactions)
 *   - Native slash command registration on bot startup
 *
 * Uses plain fetch for:
 *   - Webhook: outbound world/control-plane messages (notifyDiscord)
 *   - Bot API: task thread creation in #tasks Forum channel
 *
 * Env vars:
 *   DISCORD_WEBHOOK_URL          — webhook for the control channel  (required for any output)
 *   DISCORD_BOT_TOKEN            — bot token
 *   DISCORD_CONTROL_CHANNEL_ID   — #control-plane channel ID        (world events out)
 *   DISCORD_TASKS_CHANNEL_ID     — #tasks Forum channel ID          (auto thread-per-task)
 */
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  type Message,
} from 'discord.js';

const WEBHOOK_URL     = process.env['DISCORD_WEBHOOK_URL']        ?? '';
const BOT_TOKEN       = process.env['DISCORD_BOT_TOKEN']          ?? '';
const TASKS_CHANNEL   = process.env['DISCORD_TASKS_CHANNEL_ID']   ?? '';
const CRON_CHANNEL    = process.env['DISCORD_CRON_CHANNEL_ID']    ?? '';
const DISCORD_API     = 'https://discord.com/api/v10';
const MAX_CONTENT_LEN   = 1_950;
const FLUSH_INTERVAL_MS = 1_500;

// ─── Queue ────────────────────────────────────────────────────────────────────

type QueuedMessage = { content: string; threadId?: string; raw?: boolean; separate?: boolean };
const queue: QueuedMessage[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

const enqueue = (content: string, threadId?: string, raw = false, separate = false): void => {
  if (!WEBHOOK_URL && !BOT_TOKEN) return;
  queue.push({ content, threadId, raw, separate });
  if (!flushTimer) {
    flushTimer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
    if (flushTimer.unref) flushTimer.unref();
  }
};

// ─── Thread registry (taskId → Discord thread id) ─────────────────────────────

const threadRegistry    = new Map<string, string>();  // taskId  → threadId
const threadToTaskId    = new Map<string, string>();  // threadId → taskId
const threadTitles      = new Map<string, string>();  // taskId  → human-readable title

// ─── Cron thread registry (jobId → Discord thread id) ────────────────────────

/**
 * Minimal job shape needed by discord.ts cron functions.
 * Mirrors src/cron/types.ts but avoids a circular import.
 */
export type CronJobInfo = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  runtime: 'local' | 'docker';
  schedule: {
    kind: 'cron' | 'every' | 'at';
    expr?: string;
    tz?: string;
    everyMs?: number;
    at?: string;
  };
  payload:
    | { description: string }           // local runtime — describes what run.mjs does
    | { title: string; description: string; priority?: string };  // docker runtime
  state?: {
    lastRunAtMs?: number;
    lastStatus?: string;
    runCount?: number;
    nextRunAtMs?: number;
  };
};

const cronThreadRegistry = new Map<string, string>(); // jobId → Discord threadId

let _onThreadRegistered: ((taskId: string, channelId: string) => void) | null = null;
/** Set a callback invoked whenever a task gets a Discord thread registered (new or existing post). */
export const setOnThreadRegistered = (fn: (taskId: string, channelId: string) => void): void => {
  _onThreadRegistered = fn;
};

/**
 * Returns a Discord channel mention string "<#threadId>" for the task,
 * or null if no thread has been created yet.
 */
export const getTaskThreadMention = (taskId: string): string | null => {
  const threadId = threadRegistry.get(taskId);
  return threadId ? `<#${threadId}>` : null;
};

/**
 * If the given channelId is a Discord forum thread that was created for a task,
 * returns the taskId. Returns undefined otherwise.
 */
export const getTaskIdByChannelId = (channelId: string): string | undefined =>
  threadToTaskId.get(channelId);

/** Returns all registered task threads as { taskId, short, mention, url, title }. */
export const getActiveThreadLinks = (): Array<{ taskId: string; short: string; mention: string; url: string | null; title: string }> => {
  const result: Array<{ taskId: string; short: string; mention: string; url: string | null; title: string }> = [];
  for (const [taskId, threadId] of threadRegistry) {
    result.push({
      taskId,
      short: taskId.slice(0, 8),
      mention: `<#${threadId}>`,
      url: botGuildId ? `https://discord.com/channels/${botGuildId}/${threadId}` : null,
      title: threadTitles.get(taskId) ?? taskId.slice(0, 8),
    });
  }
  return result;
};

// ─── Public outbound API ──────────────────────────────────────────────────────

/** Post a line to the main control channel (code-block formatted). */
export const notifyDiscord = (line: string): void => enqueue(line);

/** Post a line to the main control channel without code-block wrapping (links stay clickable). */
export const notifyDiscordRaw = (line: string): void => enqueue(line, undefined, true);

/** Post a line to a task-specific thread (falls back to main channel if no thread yet). */
export const notifyTask = (taskId: string, line: string, separate = false): void =>
  enqueue(line, threadRegistry.get(taskId), false, separate);

/** Post a line directly to any thread by its Discord thread/channel ID. */
export const notifyThreadById = (threadId: string, line: string): void =>
  enqueue(line, threadId);

/** Post repo URL to the task thread once the sandbox resolves it. */
export const updateTaskThreadWithRepo = (taskId: string, repoUrl: string): void => {
  const threadId = threadRegistry.get(taskId);
  if (!threadId) return;
  enqueue(`🔗 GitHub Repo: ${repoUrl}`, threadId);
};

/** Drain queue and stop flush timer. Call on graceful shutdown. */
export const flushDiscord = async (): Promise<void> => {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  await flush();
};

// ─── Flush + send ─────────────────────────────────────────────────────────────

const flush = async (): Promise<void> => {
  if (queue.length === 0) return;
  // Group consecutive entries with the same threadId AND same raw flag into one batch.
  const groups: { threadId?: string; lines: string[]; raw: boolean }[] = [];
  for (const msg of queue.splice(0)) {
    const last = groups[groups.length - 1];
    if (last && !msg.separate && last.threadId === msg.threadId && last.raw === (msg.raw ?? false)) {
      last.lines.push(msg.content);
    } else {
      groups.push({ threadId: msg.threadId, lines: [msg.content], raw: msg.raw ?? false });
    }
  }
  for (const group of groups) {
    for (const batch of buildBatches(group.lines)) {
      // Task threads live in the forum channel — must use Bot API, not webhook
      if (group.threadId && BOT_TOKEN) {
        await sendBotMessage(batch, group.threadId, group.raw);
      } else {
        await sendWebhook(batch, group.raw);
      }
    }
  }
};

const buildBatches = (lines: string[]): string[] => {
  const batches: string[] = [];
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > MAX_CONTENT_LEN) {
      if (current) batches.push(current);
      current = line.length > MAX_CONTENT_LEN ? line.slice(0, MAX_CONTENT_LEN - 3) + '…' : line;
    } else {
      current = candidate;
    }
  }
  if (current) batches.push(current);
  return batches;
};

const sendWebhook = async (content: string, raw = false): Promise<void> => {
  if (!WEBHOOK_URL) return;
  try {
    const body = raw ? content : `\`\`\`\n${content}\n\`\`\``;
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: body }),
    });
  } catch { /* best-effort */ }
};

/** Send a message directly to a channel or thread via Bot API. */
const sendBotMessage = async (content: string, channelId: string, raw = false): Promise<void> => {
  if (!BOT_TOKEN) return;
  try {
    const body = raw ? content : `\`\`\`\n${content}\n\`\`\``;
    await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: body }),
    });
  } catch { /* best-effort */ }
};

// ─── Bot: thread creation ─────────────────────────────────────────────────────

export type TaskThreadInfo = {
  id: string;
  title: string;
  description?: string;
  leaderId?: string;
  assignedTo?: string[];
};

/**
 * Derive a concise thread title from a raw task description.
 * Uses the first non-empty line; truncates at word boundary ≤50 chars.
 */
const deriveThreadTitle = (text: string): string => {
  const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? text;
  if (firstLine.length <= 50) return firstLine;
  // Truncate at last space before limit
  const cut = firstLine.slice(0, 50);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + '…';
};

/**
 * Create a Discord thread for a task with rich metadata as starter post.
 * Registers taskId → threadId in threadRegistry.
 * No-op when BOT_TOKEN or TASKS_CHANNEL is unset.
 */
export const createTaskThread = async (task: TaskThreadInfo): Promise<void> => {
  if (!BOT_TOKEN || !TASKS_CHANNEL) return;
  if (threadRegistry.has(task.id)) return;

  const short        = task.id.slice(0, 8);
  const leader       = task.leaderId ?? '?';
  const team         = (task.assignedTo ?? [task.leaderId ?? '?']).join(', ');
  // Use description (which may be multiline) to derive a readable title
  const rawText      = task.description || task.title;
  const threadTitle  = `[${short}] ${deriveThreadTitle(rawText)}`;

  const starterBody  = [
    `📋 TASK — ${short}`,
    `${'─'.repeat(42)}`,
    `Short ID : ${short}`,
    `Full ID  : ${task.id}`,
    `Leader   : ${leader}`,
    `Team     : ${team}`,
    `${'─'.repeat(42)}`,
    `Description:`,
    rawText.slice(0, 1200),
    `${'─'.repeat(42)}`,
    `💡 /pause · /msg · /done  ← task ID auto-detected in this thread`,
  ].join('\n');

  const headers = { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' };

  const registerThread = (id: string) => {
    threadRegistry.set(task.id, id);
    threadToTaskId.set(id, task.id);
    threadTitles.set(task.id, deriveThreadTitle(rawText));
    _onThreadRegistered?.(task.id, id);
  };

  // Text channel: PUBLIC_THREAD (type 11)
  try {
    const res = await fetch(`${DISCORD_API}/channels/${TASKS_CHANNEL}/threads`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: threadTitle, type: 11, auto_archive_duration: 10080 }),
    });
    if (res.ok) {
      const data = await res.json() as { id: string };
      registerThread(data.id);
      // Post starter message into the thread
      await sendBotMessage(starterBody, data.id);
      return;
    }
  } catch { /* fall through to forum style */ }

  // Forum channel (type 15): starter message is part of the create call
  try {
    const res = await fetch(`${DISCORD_API}/channels/${TASKS_CHANNEL}/threads`, {
      method: 'POST', headers,
      body: JSON.stringify({
        name: threadTitle,
        message: { content: `\`\`\`\n${starterBody}\n\`\`\`` },
        auto_archive_duration: 10080,
      }),
    });
    if (res.ok) {
      const data = await res.json() as { id: string };
      registerThread(data.id);
    }
  } catch { /* best-effort */ }
};

/**
 * Register an already-existing Discord thread (e.g. a manually-created forum post)
 * as the thread for a task. Skips new thread creation — the post already exists.
 */
export const registerExistingThread = (taskId: string, channelId: string): void => {
  threadRegistry.set(taskId, channelId);
  threadToTaskId.set(channelId, taskId);
  threadTitles.set(taskId, channelId); // placeholder; title updated when notifyTask fires
  _onThreadRegistered?.(taskId, channelId);
};

/** Update a task thread's name to reflect its final status (✅ / ❌). */
export const closeTaskThread = async (taskId: string, status: 'completed' | 'failed'): Promise<void> => {
  if (!BOT_TOKEN) return;
  const threadId = threadRegistry.get(taskId);
  if (!threadId) return;
  // Read the existing thread name so we can preserve the base text
  try {
    const res = await fetch(`${DISCORD_API}/channels/${threadId}`);
    if (!res.ok) return;
    const data = await res.json() as { name?: string };
    const currentName = data.name ?? '';
    // Strip any existing status prefix then add new one
    const baseName = currentName.replace(/^[✅❌🔄]\s*/, '');
    const prefix = status === 'completed' ? '✅' : '❌';
    await fetch(`${DISCORD_API}/channels/${threadId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `${prefix} ${baseName}` }),
    });
  } catch { /* best-effort */ }
};

/**
 * Delete a Discord channel or thread/post by ID.
 * Returns { ok: true } on success or { ok: false, error } on failure.
 */
export const deleteDiscordChannel = async (channelId: string): Promise<{ ok: boolean; error?: string }> => {
  if (!BOT_TOKEN) return { ok: false, error: 'BOT_TOKEN not set' };
  try {
    const res = await fetch(`${DISCORD_API}/channels/${channelId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
};

// ─── Cron job Discord thread functions ──────────────────────────────────────

/** Register an existing Discord thread as the forum post for a cron job. */
export const registerCronJobThread = (jobId: string, threadId: string): void => {
  cronThreadRegistry.set(jobId, threadId);
};

/**
 * Reverse lookup: given a Discord channel/thread ID, return the cron job ID
 * registered to it, or null if it belongs to no cron job.
 */
export const getCronJobIdByThreadId = (threadId: string): string | null => {
  for (const [jobId, tid] of cronThreadRegistry.entries()) {
    if (tid === threadId) return jobId;
  }
  return null;
};

/** Returns the Discord thread URL for a cron job, or null if not registered. */
export const getCronJobThreadUrl = (jobId: string): string | null => {
  const threadId = cronThreadRegistry.get(jobId);
  if (!threadId || !botGuildId) return null;
  return `https://discord.com/channels/${botGuildId}/${threadId}`;
};

/** Enqueue a message to a cron job's Discord forum post. No-op if no thread registered. */
export const notifyCronJob = (jobId: string, line: string): void => {
  enqueue(line, cronThreadRegistry.get(jobId), true);
};

const formatCronScheduleStr = (s: CronJobInfo['schedule']): string => {
  if (s.kind === 'cron') return `${s.expr ?? '?'}${s.tz ? ` (${s.tz})` : ''}`;
  if (s.kind === 'every') return `every ${s.everyMs ?? 0}ms`;
  return `at ${s.at ?? '?'}`;
};

/**
 * Create a Discord forum post for a cron job.
 * Returns the Discord thread ID on success, null otherwise.
 * Idempotent — returns the existing ID if already registered.
 */
export const createCronJobThread = async (job: CronJobInfo): Promise<string | null> => {
  if (!BOT_TOKEN || !CRON_CHANNEL) return null;
  const existing = cronThreadRegistry.get(job.id);
  if (existing) return existing;

  const short = job.id.slice(0, 8);
  const schedStr = formatCronScheduleStr(job.schedule);
  const threadTitle = `[${short}] ${job.name.slice(0, 50)}`;

  const starterBody = [
    `⏰ CRON JOB — ${short}`,
    '─'.repeat(42),
    `ID       : ${job.id}`,
    `Name     : ${job.name}`,
    `Enabled  : ${job.enabled ? 'yes' : 'no'}`,
    `Schedule : ${job.schedule.kind}  ${schedStr}`,
    '─'.repeat(42),
    `Payload:`,
    ...(job.runtime === 'local'
      ? [
          `  runtime  : local (executes world/crons/${job.id}/run.mjs)`,
          `  desc     : ${'description' in job.payload ? (job.payload as { description: string }).description.slice(0, 300) : '(no description)'}`,
          `  @mention me in this thread to write or update the script.`,
        ]
      : [
          `  runtime  : docker`,
          `  title    : ${'title' in job.payload ? job.payload.title : ''}`,
          `  desc     : ${'description' in job.payload ? (job.payload as { description: string }).description.slice(0, 300) : ''}`,
          `  priority : ${'priority' in job.payload ? (job.payload as { priority?: string }).priority ?? 'normal' : 'normal'}`,
        ]),
    '─'.repeat(42),
    `Run log follows ↓`,
  ].join('\n');

  const headers = { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' };

  const tryCreate = async (body: Record<string, unknown>): Promise<string | null> => {
    try {
      const res = await fetch(`${DISCORD_API}/channels/${CRON_CHANNEL}/threads`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json() as { id: string };
        cronThreadRegistry.set(job.id, data.id);
        return data.id;
      }
    } catch { /* fall through */ }
    return null;
  };

  // Forum channel (type 15) — starter message included in create
  const forumId = await tryCreate({
    name: threadTitle,
    message: { content: `\`\`\`\n${starterBody}\n\`\`\`` },
    auto_archive_duration: 10080,
  });
  if (forumId) return forumId;

  // Text channel fallback — create thread, then post starter
  const textId = await tryCreate({ name: threadTitle, type: 11, auto_archive_duration: 10080 });
  if (textId) {
    await sendBotMessage(starterBody, textId);
    return textId;
  }

  return null;
};

/** Update cron job thread title to reflect enabled/disabled state. */
export const updateCronJobThreadTitle = async (jobId: string, enabled: boolean): Promise<void> => {
  if (!BOT_TOKEN) return;
  const threadId = cronThreadRegistry.get(jobId);
  if (!threadId) return;
  try {
    const res = await fetch(`${DISCORD_API}/channels/${threadId}`);
    if (!res.ok) return;
    const data = await res.json() as { name?: string };
    // Strip existing status prefix, add new one
    const base = (data.name ?? '').replace(/^[⏸▶️⏰\s]+\s*/, '');
    const prefix = enabled ? '▶️' : '⏸';
    await fetch(`${DISCORD_API}/channels/${threadId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `${prefix} ${base}` }),
    });
  } catch { /* best-effort */ }
};

/**
 * List all active threads/posts in the #tasks forum channel.
 * Returns an empty array if the bot is not initialised or the channel is unset.
 */
export const listTasksChannelPosts = async (): Promise<Array<{ id: string; name: string }>> => {
  if (!BOT_TOKEN || !botGuildId || !TASKS_CHANNEL) return [];
  try {
    const res = await fetch(`${DISCORD_API}/guilds/${botGuildId}/threads/active`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
    });
    if (!res.ok) return [];
    const data = await res.json() as { threads?: Array<{ id: string; name: string; parent_id?: string }> };
    return (data.threads ?? [])
      .filter((t) => t.parent_id === TASKS_CHANNEL)
      .map(({ id, name }) => ({ id, name }));
  } catch {
    return [];
  }
};

// ─── Conversational @mention handler — session state ────────────────────────

/**
 * Per-channel Claude Code session IDs.
 * The @anthropic-ai/claude-agent-sdk maintains full conversation state server-side;
 * we only need to track the session ID to resume the correct conversation.
 */
const channelSessions = new Map<string, string | null>();

/** Send a plain message to a Discord channel directly via Bot API. */
const sendDirectReply = async (channelId: string, content: string): Promise<void> => {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch { /* best-effort */ }
};

// ─── Slash command definitions ────────────────────────────────────────────────

const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName('new')
    .setDescription('Create a new task — opens a multiline input dialog'),
  // Note: description is entered via modal popup — supports multiline text
  new SlashCommandBuilder()
    .setName('tasks')
    .setDescription('List all tasks with their short IDs and statuses'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show status and progress of a specific task')
    .addStringOption((o) => o.setName('id').setDescription('Task ID (first 8 chars)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause a task for alignment (id optional when used inside a task thread)')
    .addStringOption((o) => o.setName('id').setDescription('Task ID — leave blank inside a task thread').setRequired(false))
    .addStringOption((o) => o.setName('message').setDescription('Opening message to the leader').setRequired(false)),
  new SlashCommandBuilder()
    .setName('msg')
    .setDescription('Send a message to a running task (id optional when used inside a task thread)')
    .addStringOption((o) => o.setName('message').setDescription('Message content').setRequired(true))
    .addStringOption((o) => o.setName('id').setDescription('Task ID — leave blank inside a task thread').setRequired(false)),
  new SlashCommandBuilder()
    .setName('done')
    .setDescription('End alignment session and let the leader proceed independently'),
].map((c) => c.toJSON());

// ─── Bot: Gateway + slash command handling ────────────────────────────────────

let commandCallback: ((line: string) => void) | null = null;
let botGuildId = '';  // set on first guild at ready — used for direct thread URLs

/**
 * Returns a direct Discord URL to a task's thread, or null if not registered.
 * Format: https://discord.com/channels/{guildId}/{threadId}
 */
export const getTaskThreadUrl = (taskId: string): string | null => {
  const threadId = threadRegistry.get(taskId);
  if (!threadId || !botGuildId) return null;
  return `https://discord.com/channels/${botGuildId}/${threadId}`;
};

/**
 * Callback type for Claude Code SDK-powered @mention processing.
 * Receives the raw user message and a per-channel session ID (null if new).
 * Returns the new session ID so the caller can persist it for the next turn.
 */
export type OnMentionFn = (
  userMessage: string,
  username: string,
  userId: string,
  channelId: string,
  sessionId: string | null,
  reply: (msg: string) => Promise<void>,
  /** Recent message history in this channel/thread, newest-last. Null if unavailable. */
  threadHistory: string | null,
) => Promise<string | null>;

/**
 * Start discord.js Gateway connection for slash command interactions.
 * Registers slash commands to all guilds on ready.
 * onCommand is called with the reconstructed raw command string (same format as stdin).
 * onMention is called when someone @mentions the bot — implement with Claude AI in world.ts.
 * No-op when BOT_TOKEN is unset.
 */
export const initDiscordBot = (onCommand: (line: string) => void, onMention?: OnMentionFn): void => {
  if (!BOT_TOKEN) return;
  commandCallback = onCommand;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,  // privileged — enable in Dev Portal → Bot → Privileged Gateway Intents
    ],
  });

  client.once('ready', async (c) => {
    console.log(`\n🤖 [Discord] Bot active — logged in as ${c.user.tag}\n`);
    // Capture first guild ID for constructing direct thread URLs
    botGuildId = c.guilds.cache.first()?.id ?? '';

    // Register slash commands as guild commands (instant, no 1-hour global delay)
    const rest = new REST().setToken(BOT_TOKEN);
    for (const guild of c.guilds.cache.values()) {
      try {
        await rest.put(Routes.applicationGuildCommands(c.user.id, guild.id), { body: SLASH_COMMANDS });
        console.log(`   Slash commands registered: ${guild.name}`);
      } catch (e) {
        console.warn(`   Failed to register commands in ${guild.name}:`, e);
      }
    }

    notifyDiscord(
      `🤖 Discord bot active\n` +
      `  Slash commands: /new  /tasks  /status  /pause  /msg  /done\n` +
      `  Or just @mention me — I understand natural language (EN/ZH)!`,
    );
  });

  // ── @mention conversational agent loop ────────────────────────────────────
  client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;
    if (!client.user) return;
    if (!message.mentions.has(client.user.id)) return;

    const username = message.author.displayName ?? message.author.username;
    const userId = message.author.id;

    // For forum thread posts, message.channelId is the THREAD id.
    // message.channel may be a ThreadChannel — resolve the correct ID.
    const ch = message.channel;
    const isThread = 'parentId' in ch && ch.parentId !== null;
    const channelId = isThread ? ch.id : message.channelId;

    const raw = message.content
      .replace(/<@!?\d+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const reply = (content: string): Promise<void> => sendDirectReply(channelId, content);

    if (!raw) {
      await reply(`👋 Hi! I'm the Vibe Guild assistant. What do you need?`);
      return;
    }

    if (!onMention) {
      await reply(`⚠️ Mention handler not initialized, please try again later.`);
      return;
    }

    console.log(`\n📨 [Discord] @mention from ${username}: "${raw.slice(0, 80)}"`);

    // ── Look up existing session for this channel ─────────────────────────
    const sessionId = channelSessions.get(channelId) ?? null;

    // ── Fetch thread / channel history (last 30 msgs before this one) ─────
    // This gives Claude context of what was discussed even after a restart.
    let threadHistory: string | null = null;
    try {
      const ch = message.channel;
      if ('messages' in ch && typeof ch.messages === 'object' && ch.messages !== null) {
        const fetched = await (ch.messages as { fetch: (opts: unknown) => Promise<Map<string, Message>> })
          .fetch({ limit: 30, before: message.id });
        const sorted = [...fetched.values()]
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        const lines = sorted
          .filter((m) => m.content.trim())
          .map((m) => {
            const who = m.author.bot ? 'VibeGuild' : (m.author.displayName ?? m.author.username);
            const text = m.content.replace(/<@!?\d+>/g, '').trim().slice(0, 500);
            return `${who}: ${text}`;
          });
        if (lines.length > 0) threadHistory = lines.join('\n');
      }
    } catch { /* channel may not support fetch — ignore */ }

    // Add reaction to indicate thinking (removed after SDK responds)
    await message.react('🤔').catch(() => undefined);

    // ── Call AI agent via Claude Code SDK ────────────────────────────────
    const newSessionId = await onMention(raw, username, userId, channelId, sessionId, reply, threadHistory).catch(async (err) => {
      console.error('[Discord] onMention error:', err);
      await reply(`❌ Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });

    // Remove thinking reaction
    await message.reactions.cache.get('🤔')?.users.remove(client.user.id).catch(() => undefined);

    // ── Store session ID for conversation continuity ──────────────────────
    if (newSessionId) {
      channelSessions.set(channelId, newSessionId);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    const user = interaction.user.displayName ?? interaction.user.username;

    // ── Modal submit: /task description ──────────────────────────────────────
    if (interaction.isModalSubmit() && interaction.customId === 'task_modal') {
      const desc = interaction.fields.getTextInputValue('description').trim();
      await interaction.reply({ content: '✅', ephemeral: true }).catch(() => undefined);
      if (desc && commandCallback) {
        const line = `/task ${desc}`;
        console.log(`\n📨 [Discord] New task from ${user}\n`);
        notifyDiscord(`📨 [${user}] /new\n───────────────────\n${desc.slice(0, 1000)}`);
        commandCallback(line);
      }
      return;
    }

    if (!interaction.isChatInputCommand() || !commandCallback) return;

    const cmd = interaction.commandName;

    // ── /new — show multiline modal ──────────────────────────────────────────
    if (cmd === 'new') {
      const modal = new ModalBuilder()
        .setCustomId('task_modal')
        .setTitle('New World Task');
      const input = new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Task description')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Enter = new line. Click Submit button to send.')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(4000);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal).catch(() => undefined);
      return;
    }

    // ── Other slash commands ──────────────────────────────────────────────────
    await interaction.reply({ content: '✅', ephemeral: true }).catch(() => undefined);

    let line = '';
    let echoExtra = '';

    // Helper: resolve task ID — from option first, then from thread context
    const resolveTaskId = (optName = 'id'): string | null => {
      const explicit = interaction.options.getString(optName);
      if (explicit) return explicit;
      return threadToTaskId.get(interaction.channelId) ?? null;
    };

    if (cmd === 'tasks') {
      line = '/tasks';
    } else if (cmd === 'status') {
      const id = interaction.options.getString('id', true);
      line = `/status ${id}`;
      echoExtra = `id: ${id}`;
    } else if (cmd === 'pause') {
      const id  = resolveTaskId();
      const msg = interaction.options.getString('message') ?? '';
      if (!id) {
        notifyDiscord(`⚠️ [${user}] /pause — no task ID and not inside a task thread`);
        return;
      }
      line = msg ? `/pause --task ${id} ${msg}` : `/pause --task ${id}`;
      echoExtra = msg ? `task: ${id}\nmessage: ${msg}` : `task: ${id}`;
    } else if (cmd === 'msg') {
      const id  = resolveTaskId();
      const msg = interaction.options.getString('message', true);
      if (!id) {
        notifyDiscord(`⚠️ [${user}] /msg — no task ID and not inside a task thread`);
        return;
      }
      line = `/msg --task ${id} ${msg}`;
      echoExtra = `task: ${id}\nmessage: ${msg}`;
    } else if (cmd === 'done') {
      line = '/done';
    }

    if (line) {
      console.log(`\n📨 [Discord] Slash command: ${line}\n`);
      const echo = echoExtra
        ? `📨 [${user}] /${cmd}\n───────────────────\n${echoExtra}`
        : `📨 [${user}] /${cmd}`;
      notifyDiscord(echo);
      commandCallback(line);
    }
  });

  client.login(BOT_TOKEN).catch((e) => {
    console.error('[Discord] Bot login failed:', e);
  });
};
