#!/usr/bin/env node
// Vibe Guild Creator CLI — core logic (called by vg and vg.ps1)
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDir, '..');

const [command = 'overview', ...args] = process.argv.slice(2);

// ─── helpers ──────────────────────────────────────────────────────────────────

const safeReadJson = (filePath, fallback) => {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
};

const countBy = (items, key) => {
  const map = new Map();
  for (const item of items) {
    const k = item?.[key] ?? 'unknown';
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
};

const fmt = (value) => {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
};

const truncate = (str, max) => {
  const s = String(str ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
};

const hr = (label = '') => console.log(`\n=== ${label} ===`);

/**
 * How many minutes ago was this date string?  Returns '-' if unparseable.
 * @param {string|undefined} isoDate
 * @returns {string}
 */
const ageMin = (isoDate) => {
  if (!isoDate) return '-';
  const ms = Date.now() - new Date(isoDate).getTime();
  if (Number.isNaN(ms) || ms < 0) return '-';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d${hrs % 24}h`;
};

// ─── data ─────────────────────────────────────────────────────────────────────

const queue       = safeReadJson(join(root, 'world', 'tasks', 'queue.json'), []);
const world       = safeReadJson(join(root, 'world', 'memory', 'world.json'), {});
const escalations = safeReadJson(join(root, 'world', 'reports', 'escalations.json'), []);

// ─── commands ─────────────────────────────────────────────────────────────────

if (command === 'overview') {
  const statusCounts = countBy(queue, 'status');
  const statusLine = [...statusCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([s, n]) => `${s}:${n}`)
    .join('  ');

  hr('Vibe Guild Overview');
  console.log(`worldStatus     : ${world?.worldStatus ?? '-'}`);
  console.log(`runtimeMode     : ${process.env['RUNTIME_MODE'] ?? 'local'}`);
  console.log(`worldDay        : ${world?.dayCount ?? '-'}`);
  console.log(`startedAt       : ${fmt(world?.startedAt)}`);
  console.log(`lastDayEndedAt  : ${fmt(world?.lastDayEndedAt)}`);
  console.log(`beings          : ${Array.isArray(world?.beings) ? world.beings.join(', ') : '-'}`);
  console.log(`tasks total     : ${queue.length}`);
  console.log(`task statuses   : ${statusLine || '-'}`);
  console.log(`escalations     : ${escalations.length}`);

  // Show in-progress task ages to help the operator spot stalled work
  const active = queue.filter((t) => t?.status === 'in-progress' || t?.status === 'assigned');
  if (active.length > 0) {
    console.log(`\nactive tasks (age since created):`);
    for (const t of active) {
      const id   = String(t?.id ?? '-').slice(0, 8);
      const age  = ageMin(t?.createdAt);
      const mode = t?.sandboxRepoUrl ? ` [docker repo: ${t.sandboxRepoUrl}]` : '';
      console.log(`  ${id}  age:${age.padEnd(6)}  ${truncate(t?.title, 50)}${mode}`);
    }
  }
  process.exit(0);
}

if (command === 'tasks') {
  const isNumber = (v) => v !== undefined && !Number.isNaN(Number(v));
  const statusFilter = !isNumber(args[0]) && args[0] ? args[0] : 'all';
  const limitArg     = isNumber(args[0]) ? args[0] : args[1];
  const limit        = limitArg ? Number(limitArg) : 20;

  const rows = queue
    .filter((t) => statusFilter === 'all' || t?.status === statusFilter)
    .sort((a, b) => String(b?.updatedAt ?? '').localeCompare(String(a?.updatedAt ?? '')))
    .slice(0, limit);

  hr(`Tasks (${statusFilter})`);
  if (rows.length === 0) { console.log('No tasks found.'); process.exit(0); }

  for (const t of rows) {
    const id       = String(t?.id ?? '-').slice(0, 8);
    const status   = String(t?.status ?? '-').padEnd(10);
    const priority = String(t?.priority ?? '-').padEnd(8);
    const age      = ageMin(t?.createdAt).padEnd(6);
    const leader   = t?.leaderId ? ` leader:${t.leaderId}` : '';
    const sandbox  = t?.sandboxRepoUrl ? ' [docker]' : '';
    const title    = truncate(t?.title, 52);
    console.log(`${id}  [${status}|${priority}| age:${age}]${leader}${sandbox}  ${title}`);
  }
  process.exit(0);
}

if (command === 'progress') {
  const inputId = args[0];
  if (!inputId) {
    console.error('Usage: vg progress <taskId-or-prefix>');
    process.exit(2);
  }

  const candidates = queue.map((t) => String(t?.id ?? '')).filter((id) => id.startsWith(inputId));
  if (candidates.length === 0) { console.error(`No task found with prefix: ${inputId}`); process.exit(1); }
  if (candidates.length > 1)   { console.error(`Ambiguous prefix: ${inputId}\n${candidates.map(c => `  - ${c}`).join('\n')}`); process.exit(1); }

  const taskId = candidates[0];
  const task   = queue.find((t) => t?.id === taskId);
  const progressPath = join(root, 'world', 'tasks', taskId, 'progress.json');

  hr('Task Progress');
  console.log(`taskId   : ${taskId}`);
  console.log(`title    : ${truncate(task?.title, 72)}`);
  console.log(`status   : ${task?.status ?? '-'}`);
  console.log(`priority : ${task?.priority ?? '-'}`);

  if (!existsSync(progressPath)) {
    console.log('\nNo progress file yet (task may not have started).');
    process.exit(0);
  }

  const p = safeReadJson(progressPath, {});
  const checkpoints = Array.isArray(p?.checkpoints) ? p.checkpoints : [];
  const latest = checkpoints[checkpoints.length - 1];

  console.log(`\nleader   : ${p?.leaderId ?? '-'}`);
  console.log(`age      : ${ageMin(task?.createdAt)}`);
  console.log(`percent  : ${p?.percentComplete ?? '-'}`);
  console.log(`summary  : ${truncate(p?.summary, 80)}`);
  console.log(`reported : ${fmt(p?.reportedAt)}`);
  if (task?.sandboxRepoUrl) console.log(`repo     : ${task.sandboxRepoUrl}`);
  if (task?.sandboxContainerId) console.log(`ctnr     : ${task.sandboxContainerId.slice(0, 12)}`);

  if (checkpoints.length > 0) {
    console.log(`\ncheckpoints (${checkpoints.length} total, showing latest):`);
    console.log(`  [${fmt(latest?.createdAt)}] ${truncate(latest?.summary, 72)}`);
  }
  process.exit(0);
}

if (command === 'escalations') {
  const limit = args[0] ? Number(args[0]) : 10;
  const list  = [...escalations]
    .sort((a, b) => String(b?.createdAt ?? '').localeCompare(String(a?.createdAt ?? '')))
    .slice(0, limit);

  hr('Escalations');
  if (list.length === 0) { console.log('No escalations.'); process.exit(0); }

  for (const e of list) {
    const who = e?.beingId ? ` [${e.beingId}]` : '';
    const urg = `[${(e?.urgency ?? 'normal').padEnd(8)}]`;
    console.log(`${fmt(e?.createdAt)}  ${urg}${who}`);
    console.log(`  ${truncate(e?.message, 100)}`);
  }
  process.exit(0);
}

if (command === 'help') {
  console.log([
    'Vibe Guild Creator CLI (vg)',
    '',
    'Usage (bash):        bash scripts/vg <command> [args]',
    'Usage (PowerShell):  .\\scripts\\vg.ps1 <command> [args]',
    '',
    'Read-only commands (vg CLI):',
    '  overview                   World day/status, beings, task counts, escalation count',
    '  tasks [status] [limit]     Compact task list (default: all, limit 20)',
    '  progress <id|prefix>       Detail view for one task',
    '  escalations [limit]        Recent escalations (default: last 10)',
    '  help                       Show this help',
    '',
    'Intervention commands (type in the world.ts terminal):',
    '  /pause --task <id> [msg]   Ask leader to stop and come align with you (sends MEETUP REQUEST).',
    '                              Leader finishes current tool call, then stops and enters dialogue.',
    '  /msg --task <id> <text>    Inject a one-off message into a running task (no alignment mode).',
    '  /done                      End alignment conversation. Leader resumes the task.',
    '  /task <description>        Quickly add a new task to the queue.',
    '',
    'World configuration (run in a separate terminal):',
    '  npm run setup              Conversational assistant: add/remove MCP servers and skills.',
    '                              Tests MCP connections before saving. Safe to run anytime.',
    '',
    'Human Alignment (leader-initiated, multi-turn):',
    '  When a leader writes status="waiting_for_human" + question to progress.json,',
    '  the system enters alignment mode. You will see a 🤔 prompt.',
    '  Just type your reply (no command prefix needed) — it goes straight to the leader.',
    '  The leader may ask follow-ups; keep typing until it resumes on its own.',
    '  Type /done at any point to tell the leader "proceed with your best judgment".',
    '',
    'Execution modes (set EXECUTION_MODE env var before starting world):',
    '  v1  (default)  Single Claude session. Leader acts for entire team.',
    '  v2             Leader spawns each team member as a subagent via Task tool.',
  ].join('\n'));
  process.exit(0);
}

console.error(`Unknown command: ${command}\nRun: vg help`);
process.exit(2);
