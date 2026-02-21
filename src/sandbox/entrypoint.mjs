#!/usr/bin/env node
/**
 * Vibe Guild — Sandbox Entrypoint
 *
 * Runs INSIDE the Docker container (vibeguild-sandbox image).
 * Receives task context via environment variables, invokes the Claude Code CLI,
 * and syncs progress back to the mounted world/ directory.
 *
 * Environment expected:
 *   TASK_ID              — world task UUID
 *   TASK_TITLE           — URI-encoded task title
 *   TASK_DESCRIPTION     — URI-encoded task description
 *   LEADER_ID            — being ID leading this task
 *   ASSIGNED_TO          — comma-separated list of all beings
 *   ANTHROPIC_API_KEY    — required for claude CLI
 *   VIBEGUILD_GITHUB_TOKEN  — optional; enables git push to sandbox repo
 *   SANDBOX_REPO_URL     — optional; GitHub repo URL for this task
 *
 * The workspace is mounted at /workspace; world/ lives at /workspace/world/.
 */

import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const TASK_ID = process.env['TASK_ID'] ?? '';
const TASK_TITLE = decodeURIComponent(process.env['TASK_TITLE'] ?? 'Untitled task');
const TASK_DESCRIPTION = decodeURIComponent(process.env['TASK_DESCRIPTION'] ?? '');
const LEADER_ID = process.env['LEADER_ID'] ?? 'leader';
const ASSIGNED_TO = (process.env['ASSIGNED_TO'] ?? LEADER_ID).split(',').map(s => s.trim()).filter(Boolean);
const SANDBOX_REPO_URL = process.env['SANDBOX_REPO_URL'] ?? '';

const WORKSPACE = '/workspace';
const WORLD_ROOT = join(WORKSPACE, 'world');
const TASK_DIR = join(WORLD_ROOT, 'tasks', TASK_ID);

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * @param {string} p
 * @returns {Promise<unknown>}
 */
const safeReadJson = async (p) => {
  try {
    const raw = await readFile(p, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * @param {'in-progress'|'completed'|'failed'|'blocked'} status
 * @param {string} summary
 * @param {number} percent
 * @param {object} [extra]
 */
const writeProgress = async (status, summary, percent, extra = {}) => {
  const worldJson = await safeReadJson(join(WORLD_ROOT, 'memory', 'world.json'));
  const worldDay = worldJson?.dayCount ?? 0;
  await mkdir(TASK_DIR, { recursive: true });
  await writeFile(
    join(TASK_DIR, 'progress.json'),
    JSON.stringify(
      {
        taskId: TASK_ID,
        leaderId: LEADER_ID,
        worldDay,
        reportedAt: new Date().toISOString(),
        status,
        summary,
        percentComplete: percent,
        checkpoints: [],
        ...(SANDBOX_REPO_URL ? { sandboxRepoUrl: SANDBOX_REPO_URL } : {}),
        ...extra,
      },
      null,
      2,
    ),
    'utf-8',
  );
};

/** @returns {Promise<string[]>} */
const drainInbox = async () => {
  const inboxPath = join(TASK_DIR, 'inbox.json');
  try {
    const raw = await readFile(inboxPath, 'utf-8');
    const data = JSON.parse(raw);
    const msgs = data?.messages ?? [];
    // Clear inbox after reading
    await writeFile(
      inboxPath,
      JSON.stringify({ messages: [], updatedAt: new Date().toISOString() }, null, 2),
      'utf-8',
    );
    return msgs;
  } catch {
    return [];
  }
};

// ─── prompt ───────────────────────────────────────────────────────────────────

const buildPrompt = () => {
  const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const teamList = ASSIGNED_TO.join(', ');
  const lines = [
    `You are ${LEADER_ID}, team leader for a Vibe Guild world task running in a Docker sandbox.`,
    `Your full team: ${teamList}`,
    ``,
    `**Task:** ${TASK_TITLE}`,
    `**Task ID:** ${TASK_ID}`,
    ``,
    `## Task description`,
    TASK_DESCRIPTION,
    ``,
    `## Your responsibilities (execute in order)`,
    ``,
    `### Phase 1 — Execute the task`,
    `1. Execute this task fully and autonomously.`,
    `2. Write progress.json at EVERY significant step (not just start/end):`,
    `   File: world/tasks/${TASK_ID}/progress.json`,
    `   Schema: { taskId, leaderId, worldDay (read from world/memory/world.json), reportedAt,`,
    `             status ("in-progress"|"completed"|"failed"), summary (current step description),`,
    `             percentComplete (0-100), checkpoints: [{time, message}], artifacts?: {} }`,
    `   IMPORTANT: Update progress.json after each meaningful action so the human operator`,
    `   can monitor your progress in real-time. Aim for an update every 2-5 tool calls.`,
    `3. Poll for human instructions in: world/tasks/${TASK_ID}/inbox.json`,
    `   If inbox has messages, acknowledge them and incorporate the guidance before continuing.`,
    `4. When done: write status "completed" (or "failed") in progress.json.`,
    ``,
    `### Phase 2 — Post-task memory (REQUIRED after Phase 1 completes)`,
    `For EVERY being in the team [${teamList}], do the following:`,
    ``,
    `**A. Write a self-note for each being:**`,
    `   File: world/beings/{being-id}/memory/self-notes/${ts}.json`,
    `   Create the directory with mkdir if it doesn't exist.`,
    `   Schema:`,
    `   {`,
    `     "timestamp": "${ts}",`,
    `     "taskId": "${TASK_ID}",`,
    `     "title": "<short title for this task>",`,
    `     "role": "<what this being contributed to the task>",`,
    `     "summary": "<what was accomplished>",`,
    `     "keyDecisions": ["<decision 1>", ...],`,
    `     "learnings": ["<thing learned 1>", ...],`,
    `     "followUps": ["<future action 1>", ...]`,
    `   }`,
    ``,
    `**B. Update profile.json for each being:**`,
    `   File: world/beings/{being-id}/profile.json`,
    `   Read the existing profile, then:`,
    `   - Add any new skills demonstrated in this task to the "skills" array (avoid duplicates)`,
    `   - Update "status" to "idle"`,
    `   - Add a "lastTaskId" field with value "${TASK_ID}"`,
    `   - Add a "lastTaskAt" field with the current ISO timestamp`,
    `   Write the updated profile back.`,
    ``,
    `Note: You are the leader so you write on behalf of all beings. Each being has a different`,
    `perspective — tailor their self-note to match their role in the task.`,
  ];

  if (SANDBOX_REPO_URL) {
    lines.push(
      ``,
      `**Execution repo:** ${SANDBOX_REPO_URL}`,
      `Push important artifacts, code, and notes there via git.`,
    );
  }

  return lines.join('\n');
};

// ─── main ─────────────────────────────────────────────────────────────────────

const run = async () => {
  if (!TASK_ID) {
    console.error('[sandbox] TASK_ID is not set. Exiting.');
    process.exit(1);
  }

  console.log(`[sandbox] Starting task ${TASK_ID.slice(0, 8)}: ${TASK_TITLE}`);
  await writeProgress('in-progress', 'Sandbox agent starting…', 0);

  // Check for any messages already in inbox before launching claude
  const initialMsgs = await drainInbox();
  const prompt = buildPrompt();
  const fullPrompt = initialMsgs.length > 0
    ? `${prompt}\n\n--- INITIAL INSTRUCTIONS FROM OPERATOR ---\n${initialMsgs.map((m) => `> ${m}`).join('\n')}\n---`
    : prompt;

  // Invoke Claude Code CLI
  const modelArgs = process.env['ANTHROPIC_MODEL']
    ? ['--model', process.env['ANTHROPIC_MODEL']]
    : [];
  const proc = spawn(
    'claude',
    ['--dangerously-skip-permissions', ...modelArgs, '-p', fullPrompt],
    {
      cwd: WORKSPACE,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    },
  );

  proc.stdout?.on('data', (/** @type {Buffer} */ d) => {
    process.stdout.write(`[${LEADER_ID}] ${d.toString()}`);
  });
  proc.stderr?.on('data', (/** @type {Buffer} */ d) => {
    process.stderr.write(`[${LEADER_ID}:err] ${d.toString()}`);
  });

  await new Promise((resolve, reject) => {
    proc.on('close', (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`claude exited with code ${code}`));
    });
  });

  // Final progress sync (the leader may have already written completed — that's fine)
  const current = await safeReadJson(join(TASK_DIR, 'progress.json'));
  if (!current || current.status !== 'completed') {
    await writeProgress('completed', 'Sandbox agent finished execution.', 100);
  }

  console.log(`[sandbox] Task ${TASK_ID.slice(0, 8)} done.`);
};

run().catch(async (err) => {
  console.error('[sandbox] Fatal error:', err.message ?? err);
  await writeProgress('failed', `Sandbox error: ${err.message ?? err}`, 0).catch(() => undefined);
  process.exit(1);
});
