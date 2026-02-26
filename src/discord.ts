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
const DISCORD_API     = 'https://discord.com/api/v10';
const MAX_CONTENT_LEN   = 1_950;
const FLUSH_INTERVAL_MS = 1_500;

// ─── Queue ────────────────────────────────────────────────────────────────────

type QueuedMessage = { content: string; threadId?: string };
const queue: QueuedMessage[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

const enqueue = (content: string, threadId?: string): void => {
  if (!WEBHOOK_URL) return;
  queue.push({ content, threadId });
  if (!flushTimer) {
    flushTimer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
    if (flushTimer.unref) flushTimer.unref();
  }
};

// ─── Thread registry (taskId → Discord thread id) ─────────────────────────────

const threadRegistry    = new Map<string, string>();  // taskId  → threadId
const threadToTaskId    = new Map<string, string>();  // threadId → taskId

// ─── Public outbound API ──────────────────────────────────────────────────────

/** Post a line to the main control channel. */
export const notifyDiscord = (line: string): void => enqueue(line);

/** Post a line to a task-specific thread (falls back to main channel if no thread yet). */
export const notifyTask = (taskId: string, line: string): void =>
  enqueue(line, threadRegistry.get(taskId));

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
  // Group consecutive entries with the same threadId into one batch.
  const groups: { threadId?: string; lines: string[] }[] = [];
  for (const msg of queue.splice(0)) {
    const last = groups[groups.length - 1];
    if (last && last.threadId === msg.threadId) {
      last.lines.push(msg.content);
    } else {
      groups.push({ threadId: msg.threadId, lines: [msg.content] });
    }
  }
  for (const group of groups) {
    for (const batch of buildBatches(group.lines)) {
      // Task threads live in the forum channel — must use Bot API, not webhook
      if (group.threadId && BOT_TOKEN) {
        await sendBotMessage(batch, group.threadId);
      } else {
        await sendWebhook(batch);
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

const sendWebhook = async (content: string): Promise<void> => {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `\`\`\`\n${content}\n\`\`\`` }),
    });
  } catch { /* best-effort */ }
};

/** Send a message directly to a channel or thread via Bot API. */
const sendBotMessage = async (content: string, channelId: string): Promise<void> => {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `\`\`\`\n${content}\n\`\`\`` }),
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

// ─── Conversational @mention handler ────────────────────────────────────────

type ParsedIntent =
  | { type: 'new_task'; description: string }
  | { type: 'tasks' }
  | { type: 'status'; id: string }
  | { type: 'pause'; id: string; message?: string }
  | { type: 'msg'; id: string; message: string }
  | { type: 'done' }
  | { type: 'help' }
  | { type: 'unknown'; raw: string };

type PendingConfirm = {
  intent: 'new_task';
  description: string;
  userId: string;
  channelId: string;
};

/** Per-channel pending confirmation state. */
const pendingConfirms = new Map<string, PendingConfirm>();

/** Parse human natural-language text into a structured command intent. */
const parseIntent = (text: string): ParsedIntent => {
  const t = text.trim();
  const lower = t.toLowerCase();

  // Help
  if (/^\/?help$/i.test(t) || /^(what can you do|how do i use|commands)/i.test(lower)) {
    return { type: 'help' };
  }

  // /done / resume / proceed
  if (/^\/?done$/i.test(t) || /^(proceed|go ahead|let .* proceed|继续|好的?|执行吧?)/i.test(lower)) {
    return { type: 'done' };
  }

  // /tasks / list / show tasks
  if (/^\/?tasks?$/i.test(t) || /\b(list|show|get|all|查看|列出|显示).{0,20}\btasks?\b/i.test(lower) || /\btasks?\.?$/i.test(lower)) {
    return { type: 'tasks' };
  }

  // /status <id> or "status of <id>" or "progress of <id>"
  const statusMatch = t.match(/(?:\/status|status(?: of)?|progress(?: of)?|进度)\s+([a-f0-9]{4,36})/i);
  if (statusMatch) return { type: 'status', id: statusMatch[1] };

  // /pause --task <id> [message] or "pause <id>"
  const pauseMatch = t.match(/(?:\/pause|pause|暂停)\s+(?:--task\s+)?([a-f0-9]{4,36})(?: (.+))?/i);
  if (pauseMatch) return { type: 'pause', id: pauseMatch[1], message: pauseMatch[2]?.trim() };

  // /msg --task <id> <message> or "message <id>: text"
  const msgMatch = t.match(/(?:\/msg|msg|message|发消息|send)\s+(?:--task\s+)?([a-f0-9]{4,36})[:：]?\s+(.+)/i);
  if (msgMatch) return { type: 'msg', id: msgMatch[1], message: msgMatch[2] };

  // new task / create task — keyword prefix then description
  const newMatch = t.match(/(?:\/new|\/task|(?:new|create|add)\s+task|创建任务|新任务)[:\s]+(.+)/is);
  if (newMatch) return { type: 'new_task', description: newMatch[1].trim() };

  // Fallback: if message is long (>30 chars) and doesn't match anything, treat as a new task description prompt
  if (t.length > 30 && !/^[a-f0-9]{4,36}$/i.test(t)) {
    return { type: 'new_task', description: t };
  }

  return { type: 'unknown', raw: t };
};

const HELP_TEXT = [
  '👋 **Vibe Guild Bot** — talk to me naturally or use these patterns:',
  '• `new task: <description>` — create a new world task',
  '• `list tasks` — show all tasks with status',
  '• `status <id>` — detailed status for a task',
  '• `pause <id> [message]` — pause task for alignment',
  '• `msg <id>: <text>` — inject message into running task',
  '• `done` — end alignment and let leader proceed',
  '',
  'You can also just describe what you want in plain English!',
].join('\n');

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

/**
 * Start discord.js Gateway connection for slash command interactions.
 * Registers slash commands to all guilds on ready.
 * onCommand is called with the reconstructed raw command string (same format as stdin).
 * No-op when BOT_TOKEN is unset.
 */
export const initDiscordBot = (onCommand: (line: string) => void): void => {
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
      `  Or just @mention me in this channel with plain English!`,
    );
  });

  // ── @mention conversational handler ────────────────────────────────────────
  client.on('messageCreate', async (message: Message) => {
    // Ignore bots and messages that don't @mention this bot
    if (message.author.bot) return;
    if (!client.user) return;
    if (!message.mentions.has(client.user.id)) return;

    const username = message.author.displayName ?? message.author.username;
    const channelId = message.channelId;

    // Strip the @mention and clean up whitespace
    const raw = message.content
      .replace(/<@!?\d+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // ── Check for pending confirmation in this channel ────────────────────
    const pending = pendingConfirms.get(channelId);
    if (pending && pending.userId === message.author.id) {
      const isYes = /^(yes|y|ok|sure|confirm|go|proceed|yep|yeah|好|是|确认|执行|继续)/i.test(raw);
      const isNo  = /^(no|n|cancel|nope|stop|取消|不|算了)/i.test(raw);

      if (isYes) {
        pendingConfirms.delete(channelId);
        if (pending.intent === 'new_task') {
          await sendDirectReply(channelId, `✅ Creating task...`);
          console.log(`\n📨 [Discord] @mention new task from ${username}`);
          notifyDiscord(`📨 [${username}] new task (via @mention)\n${'─'.repeat(42)}\n${pending.description.slice(0, 800)}`);
          commandCallback?.(`/task ${pending.description}`);
        }
        return;
      }
      if (isNo) {
        pendingConfirms.delete(channelId);
        await sendDirectReply(channelId, `❌ Cancelled. Let me know if you need anything else.`);
        return;
      }
      // If neither yes/no, fall through to re-parse as a fresh command
      pendingConfirms.delete(channelId);
    }

    if (!raw) {
      await sendDirectReply(channelId, HELP_TEXT);
      return;
    }

    const intent = parseIntent(raw);
    console.log(`\n📨 [Discord] @mention from ${username}: ${intent.type}`);

    switch (intent.type) {
      case 'help': {
        await sendDirectReply(channelId, HELP_TEXT);
        break;
      }

      case 'new_task': {
        // Ask for confirmation before creating
        const preview = intent.description.slice(0, 600);
        pendingConfirms.set(channelId, {
          intent: 'new_task',
          description: intent.description,
          userId: message.author.id,
          channelId,
        });
        await sendDirectReply(
          channelId,
          `📋 Got it. I'll create the following task:\n\`\`\`\n${preview}${intent.description.length > 600 ? '\n…(truncated)' : ''}\n\`\`\`\nShall I proceed? (yes / no)`,
        );
        break;
      }

      case 'tasks': {
        await sendDirectReply(channelId, '📋 Fetching task list…');
        notifyDiscord(`📨 [${username}] tasks (via @mention)`);
        commandCallback?.('/tasks');
        break;
      }

      case 'status': {
        await sendDirectReply(channelId, `🔍 Fetching status for \`${intent.id}\`…`);
        notifyDiscord(`📨 [${username}] status ${intent.id} (via @mention)`);
        commandCallback?.(`/status ${intent.id}`);
        break;
      }

      case 'pause': {
        const line = intent.message
          ? `/pause --task ${intent.id} ${intent.message}`
          : `/pause --task ${intent.id}`;
        await sendDirectReply(channelId, `⏸ Requesting alignment with task \`${intent.id}\`…`);
        notifyDiscord(`📨 [${username}] pause ${intent.id}${intent.message ? ` — "${intent.message}"` : ''} (via @mention)`);
        commandCallback?.(line);
        break;
      }

      case 'msg': {
        await sendDirectReply(channelId, `💬 Sending message to task \`${intent.id}\`…`);
        notifyDiscord(`📨 [${username}] msg ${intent.id}: ${intent.message.slice(0, 200)} (via @mention)`);
        commandCallback?.(`/msg --task ${intent.id} ${intent.message}`);
        break;
      }

      case 'done': {
        await sendDirectReply(channelId, `▶️ Ending alignment — letting the leader proceed independently.`);
        notifyDiscord(`📨 [${username}] done (via @mention)`);
        commandCallback?.('/done');
        break;
      }

      default: {
        // Unknown intent
        await sendDirectReply(
          channelId,
          `🤔 I couldn't figure out what you mean by \`${(intent as { raw: string }).raw.slice(0, 100)}\`.\n\n${HELP_TEXT}`,
        );
      }
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
