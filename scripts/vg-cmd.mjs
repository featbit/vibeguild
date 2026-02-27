#!/usr/bin/env node
/**
 * vg-cmd.mjs — World command queueing helper for the Discord bot.
 *
 * The Claude Code SDK agent (handleMention in world.ts) cannot call world.ts
 * functions directly. Instead, it queues commands here via Bash during its run,
 * and world.ts drains the queue after each SDK call completes.
 *
 * Usage (called by Claude via Bash inside the SDK query loop):
 *   node scripts/vg-cmd.mjs cmd "/task write a blog post about feature flags"
 *   node scripts/vg-cmd.mjs cmd "/revise abc12345 please add more examples"
 *   node scripts/vg-cmd.mjs cmd "/pause --task abc12345 review the plan"
 *   node scripts/vg-cmd.mjs cmd "/msg --task abc12345 stop and wait for me"
 *   node scripts/vg-cmd.mjs cmd "/done"
 *
 * Commands are appended to world/discord-pending-cmds.json.
 * world.ts reads and clears this file after every SDK turn.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDir, '..');
const worldDir = join(root, 'world');
const cmdFile = join(worldDir, 'discord-pending-cmds.json');

const [subcommand, commandStr, channelId] = process.argv.slice(2);

if (subcommand === 'cmd') {
  const command = (commandStr ?? '').trim();
  if (!command) {
    console.error('Usage: node scripts/vg-cmd.mjs cmd "<world command>" [channelId]');
    process.exit(1);
  }
  if (!command.startsWith('/')) {
    console.error('Error: command must start with /');
    process.exit(1);
  }

  // Ensure world dir exists
  if (!existsSync(worldDir)) {
    mkdirSync(worldDir, { recursive: true });
  }

  // Read current queue (or start fresh)
  let queue = [];
  try {
    queue = JSON.parse(readFileSync(cmdFile, 'utf8'));
  } catch { /* file missing or empty — start fresh */ }

  // Append entry — include channelId when provided so world.ts can reuse the post
  const entry = channelId ? { cmd: command, channelId } : command;
  queue.push(entry);
  writeFileSync(cmdFile, JSON.stringify(queue, null, 2), 'utf8');
  console.log(`Queued: ${command}${channelId ? ` (channelId=${channelId})` : ''}`);
} else {
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error('Available: cmd');
  process.exit(1);
}
