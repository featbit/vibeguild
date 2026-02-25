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

const threadRegistry = new Map<string, string>();

// ─── Public outbound API ──────────────────────────────────────────────────────

/** Post a line to the main control channel. */
export const notifyDiscord = (line: string): void => enqueue(line);

/** Post a line to a task-specific thread (falls back to main channel if no thread yet). */
export const notifyTask = (taskId: string, line: string): void =>
  enqueue(line, threadRegistry.get(taskId));

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

/**
 * Create a Discord thread for a task and register its ID.
 * Uses DISCORD_TASKS_CHANNEL_ID (the #tasks Forum channel).
 * No-op when BOT_TOKEN or TASKS_CHANNEL is unset.
 */
export const createTaskThread = async (taskId: string, title: string): Promise<void> => {
  if (!BOT_TOKEN || !TASKS_CHANNEL) return;
  if (threadRegistry.has(taskId)) return;
  const name = `${taskId.slice(0, 8)} — ${title.slice(0, 80)}`;
  const headers = { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' };

  // Text channel: PUBLIC_THREAD (type 11)
  try {
    const res = await fetch(`${DISCORD_API}/channels/${TASKS_CHANNEL}/threads`, {
      method: 'POST', headers,
      body: JSON.stringify({ name, type: 11, auto_archive_duration: 10080 }),
    });
    if (res.ok) {
      const data = await res.json() as { id: string };
      threadRegistry.set(taskId, data.id);
      return;
    }
  } catch { /* fall through to forum style */ }

  // Forum channel (type 15): requires a starter message
  try {
    const res = await fetch(`${DISCORD_API}/channels/${TASKS_CHANNEL}/threads`, {
      method: 'POST', headers,
      body: JSON.stringify({
        name,
        message: { content: `📋 Task \`${taskId.slice(0, 8)}\`\n**${title}**` },
        auto_archive_duration: 10080,
      }),
    });
    if (res.ok) {
      const data = await res.json() as { id: string };
      threadRegistry.set(taskId, data.id);
    }
  } catch { /* best-effort */ }
};

// ─── Slash command definitions ────────────────────────────────────────────────

const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName('task')
    .setDescription('Add a new world task (opens a multiline input dialog)'),
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
    .setDescription('Pause a task for alignment with the creator')
    .addStringOption((o) => o.setName('id').setDescription('Task ID (first 8 chars)').setRequired(true))
    .addStringOption((o) => o.setName('message').setDescription('Opening message to the leader').setRequired(false)),
  new SlashCommandBuilder()
    .setName('msg')
    .setDescription('Send a message to a running task')
    .addStringOption((o) => o.setName('id').setDescription('Task ID (first 8 chars)').setRequired(true))
    .addStringOption((o) => o.setName('message').setDescription('Message content').setRequired(true)),
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

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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
      `🤖 Discord bot active — slash commands available:\n` +
      `  /task  /tasks  /status  /pause  /msg  /done`,
    );
  });

  client.on('interactionCreate', async (interaction) => {
    const user = interaction.user.displayName ?? interaction.user.username;

    // ── Modal submit: /task description ──────────────────────────────────────
    if (interaction.isModalSubmit() && interaction.customId === 'task_modal') {
      const desc = interaction.fields.getTextInputValue('description').trim();
      await interaction.reply({ content: '✅', ephemeral: true }).catch(() => undefined);
      if (desc && commandCallback) {
        const line = `/task ${desc}`;
        console.log(`\n📨 [Discord] Modal task from ${user}\n`);
        notifyDiscord(`📨 [${user}] /task\n───────────────────\n${desc.slice(0, 1000)}`);
        commandCallback(line);
      }
      return;
    }

    if (!interaction.isChatInputCommand() || !commandCallback) return;

    const cmd = interaction.commandName;

    // ── /task — show multiline modal instead of single-line option ────────────
    if (cmd === 'task') {
      const modal = new ModalBuilder()
        .setCustomId('task_modal')
        .setTitle('New World Task');
      const input = new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Task description (multiline supported)')
        .setStyle(TextInputStyle.Paragraph)
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

    if (cmd === 'tasks') {
      line = '/tasks';
    } else if (cmd === 'status') {
      const id = interaction.options.getString('id', true);
      line = `/status ${id}`;
      echoExtra = `id: ${id}`;
    } else if (cmd === 'pause') {
      const id  = interaction.options.getString('id', true);
      const msg = interaction.options.getString('message') ?? '';
      line = msg ? `/pause --task ${id} ${msg}` : `/pause --task ${id}`;
      echoExtra = msg ? `task: ${id}\nmessage: ${msg}` : `task: ${id}`;
    } else if (cmd === 'msg') {
      const id  = interaction.options.getString('id', true);
      const msg = interaction.options.getString('message', true);
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
