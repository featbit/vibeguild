#!/usr/bin/env node
/**
 * vg-write.mjs — Copilot write-side CLI for the Vibe Guild world
 *
 * Usage (called by Copilot Chat as control plane):
 *   node scripts/vg-write.mjs add-task "<description>" [--priority normal|high|low|critical] [--title "<title>"]
 *   node scripts/vg-write.mjs inject-message <taskId> "<message>"
 *   node scripts/vg-write.mjs pause-task <taskId> ["<optional message>"]
 *   node scripts/vg-write.mjs resume [--task <taskId>]
 *   node scripts/vg-write.mjs revise <taskId> "<feedback>"
 *
 * All commands operate on world/ JSON files directly — no running world process needed.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDir, '..');
const worldDir = join(root, 'world');

const [command, ...args] = process.argv.slice(2);

// ─── helpers ────────────────────────────────────────────────────────────────

const readJson = (filePath, fallback) => {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJson = (filePath, data) => {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
};

const parseFlags = (argv) => {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      flags[key] = argv[i + 1] ?? true;
      i++;
    } else {
      positional.push(argv[i]);
    }
  }
  return { flags, positional };
};

/** Find a task by full ID or short prefix */
const findTask = (tasks, idOrPrefix) => {
  return tasks.find(
    (t) => t.id === idOrPrefix || t.id.startsWith(idOrPrefix),
  );
};

const tasksQueuePath = join(worldDir, 'tasks', 'queue.json');
const signalsPath = join(worldDir, 'signals.json');

const appendSignal = (type, payload) => {
  const signals = readJson(signalsPath, []);
  signals.push({
    id: `${type}-${Date.now()}`,
    type,
    payload,
    createdAt: new Date().toISOString(),
    processed: false,
  });
  writeJson(signalsPath, signals);
};

// ─── commands ────────────────────────────────────────────────────────────────

const cmdAddTask = () => {
  const { flags, positional } = parseFlags(args);
  const description = positional.join(' ').trim();
  if (!description) {
    console.error('Usage: vg-write.mjs add-task "<description>" [--priority normal|high|low|critical] [--title "<title>"]');
    process.exit(1);
  }
  const priority = ['low', 'normal', 'high', 'critical'].includes(flags.priority)
    ? flags.priority
    : 'normal';
  const title = (typeof flags.title === 'string' ? flags.title : description).slice(0, 80);

  const tasks = readJson(tasksQueuePath, []);
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    title,
    description,
    status: 'pending',
    priority,
    taskKind: 'skill_demo_trigger',
    createdAt: now,
    updatedAt: now,
    leadRole: 'TeamLead',
    roles: ['TeamLead', 'Developer', 'Researcher', 'Writer', 'Reviewer'],
    createdBy: 'human',
    revisionCount: 0,
    completionLevel: 'not_started',
  };
  tasks.push(task);
  writeJson(tasksQueuePath, tasks);

  appendSignal('TASK_ADDED', { taskId: task.id, title: task.title });

  console.log(`\n✅ Task enqueued:`);
  console.log(`   ID:          ${task.id}`);
  console.log(`   Title:       ${task.title}`);
  console.log(`   Priority:    ${task.priority}`);
  console.log(`\n   Scheduler picks it up on next tick (every 5 s).\n`);
};

const cmdInjectMessage = () => {
  const { positional } = parseFlags(args);
  const [taskIdPrefix, ...msgParts] = positional;
  const message = msgParts.join(' ').trim();

  if (!taskIdPrefix || !message) {
    console.error('Usage: vg-write.mjs inject-message <taskId> "<message>"');
    process.exit(1);
  }

  const tasks = readJson(tasksQueuePath, []);
  const task = findTask(tasks, taskIdPrefix);
  if (!task) {
    console.error(`\n⚠️  No task found matching "${taskIdPrefix}"\n`);
    process.exit(1);
  }

  const taskDir = join(worldDir, 'tasks', task.id);
  const inboxPath = join(taskDir, 'inbox.json');
  mkdirSync(taskDir, { recursive: true });

  const inbox = readJson(inboxPath, { messages: [] });
  if (!Array.isArray(inbox.messages)) inbox.messages = [];
  inbox.messages.push(message);
  writeJson(inboxPath, inbox);

  console.log(`\n✅ Message injected → task ${task.id.slice(0, 8)}`);
  console.log(`   "${message.slice(0, 120)}"\n`);
};

const cmdPauseTask = () => {
  const { positional } = parseFlags(args);
  const [taskIdPrefix, ...msgParts] = positional;
  const message = msgParts.join(' ').trim() || 'Creator requested alignment';

  if (!taskIdPrefix) {
    console.error('Usage: vg-write.mjs pause-task <taskId> ["<message>"]');
    process.exit(1);
  }

  const tasks = readJson(tasksQueuePath, []);
  const task = findTask(tasks, taskIdPrefix);
  if (!task) {
    console.error(`\n⚠️  No task found matching "${taskIdPrefix}"\n`);
    process.exit(1);
  }

  const taskDir = join(worldDir, 'tasks', task.id);
  mkdirSync(taskDir, { recursive: true });

  // Write pause.signal — entrypoint polls for this and kills Claude immediately
  writeJson(join(taskDir, 'pause.signal'), {
    requestedAt: new Date().toISOString(),
    message,
  });

  // Also inject a meetup request into inbox so Claude sees context on resume
  const inboxPath = join(taskDir, 'inbox.json');
  const inbox = readJson(inboxPath, { messages: [] });
  if (!Array.isArray(inbox.messages)) inbox.messages = [];
  inbox.messages.push(
    `[MEETUP REQUEST] The creator wants to align with you. ` +
    `Please stop all current work immediately. ` +
    `Write progress.json with status="waiting_for_human", a brief summary of what you were doing, and a "question" field acknowledging you are ready to align. ` +
    `Then wait — do not continue the task until the creator says so.` +
    (message !== 'Creator requested alignment' ? ` Creator's message: ${message}` : ''),
  );
  writeJson(inboxPath, inbox);

  console.log(`\n⏸  Pause signal written → task ${task.id.slice(0, 8)}`);
  console.log(`   Claude will stop at its next checkpoint and wait for input.`);
  console.log(`   Use "vg-write.mjs inject-message ${task.id.slice(0, 8)} <reply>" to respond.\n`);
};

const cmdResume = () => {
  const { flags, positional } = parseFlags(args);
  const taskIdPrefix = flags.task ?? positional[0];

  if (taskIdPrefix) {
    // Task-specific resume: resolve full ID
    const tasks = readJson(tasksQueuePath, []);
    const task = findTask(tasks, taskIdPrefix);
    if (!task) {
      console.error(`\n⚠️  No task found matching "${taskIdPrefix}"\n`);
      process.exit(1);
    }

    // Remove pause.signal if present
    const signalPath = join(worldDir, 'tasks', task.id, 'pause.signal');
    if (existsSync(signalPath)) {
      writeFileSync(signalPath + '.cleared', JSON.stringify({ clearedAt: new Date().toISOString() }), 'utf8');
      writeFileSync(signalPath, '', 'utf8'); // zero it out (entrypoint checks existence+content)
    }

    appendSignal('MEETUP_RESUME', { taskId: task.id });
    console.log(`\n▶️  Resume signal sent → task ${task.id.slice(0, 8)}\n`);
  } else {
    // Global resume
    appendSignal('MEETUP_RESUME', {});
    console.log(`\n▶️  Global resume signal sent. World will unfreeze on next tick.\n`);
  }
};

const cmdRevise = () => {
  const { positional } = parseFlags(args);
  const [taskIdPrefix, ...feedbackParts] = positional;
  const feedback = feedbackParts.join(' ').trim();

  if (!taskIdPrefix || !feedback) {
    console.error('Usage: vg-write.mjs revise <taskId> "<feedback>"');
    process.exit(1);
  }

  const tasks = readJson(tasksQueuePath, []);
  const taskIdx = tasks.findIndex(
    (t) => t.id === taskIdPrefix || t.id.startsWith(taskIdPrefix),
  );
  if (taskIdx === -1) {
    console.error(`\n⚠️  No task found matching "${taskIdPrefix}"\n`);
    process.exit(1);
  }

  const task = tasks[taskIdx];
  if (task.status !== 'completed' && task.status !== 'failed') {
    console.error(`\n⚠️  Task ${task.id.slice(0, 8)} is "${task.status}" — can only revise completed or failed tasks.\n`);
    process.exit(1);
  }

  // Increment revision, reset status to pending
  const revisionCount = (task.revisionCount ?? 0) + 1;
  const now = new Date().toISOString();
  tasks[taskIdx] = {
    ...task,
    status: 'pending',
    completionLevel: 'not_started',
    revisionCount,
    updatedAt: now,
  };
  writeJson(tasksQueuePath, tasks);

  // Write revision instructions to inbox.json
  const taskDir = join(worldDir, 'tasks', task.id);
  mkdirSync(taskDir, { recursive: true });
  writeJson(join(taskDir, 'inbox.json'), {
    messages: [
      `[REVISION REQUEST] The creator has reviewed your previous output and is not satisfied.\n` +
      `This is revision #${revisionCount}.\n\n` +
      `Creator's feedback:\n${feedback}\n\n` +
      `Please review the existing repo and outputs, then address the feedback. ` +
      `Continue from where you left off — do not start from scratch unless the feedback explicitly says so.`,
    ],
  });

  appendSignal('TASK_ADDED', { taskId: task.id, title: task.title });

  console.log(`\n✏️  Revision #${revisionCount} queued for task ${task.id.slice(0, 8)}`);
  console.log(`   "${task.title.slice(0, 72)}"`);
  console.log(`   Feedback: "${feedback.slice(0, 120)}"\n`);
};

// ─── dispatch ────────────────────────────────────────────────────────────────

const helpText = `
Vibe Guild Write CLI — operator commands (called by Copilot as control plane)

Commands:
  add-task "<desc>" [--priority normal|high|low|critical] [--title "<title>"]
      Add a new task to the world queue.

  inject-message <taskId> "<message>"
      Send a message to a running task's inbox (alignment replies, instructions).

  pause-task <taskId> ["<message>"]
      Request task alignment — writes pause.signal to stop Claude immediately.

  resume [--task <taskId>]
      Resume a frozen task or the whole world.

  revise <taskId> "<feedback>"
      Re-queue a completed/failed task with creator feedback.
`;

switch (command) {
  case 'add-task':       cmdAddTask();       break;
  case 'inject-message': cmdInjectMessage(); break;
  case 'pause-task':     cmdPauseTask();     break;
  case 'resume':         cmdResume();        break;
  case 'revise':         cmdRevise();        break;
  default:
    console.log(helpText);
    if (command && command !== '--help' && command !== 'help') {
      console.error(`Unknown command: ${command}\n`);
      process.exit(1);
    }
}
