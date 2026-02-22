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
import { writeFile, readFile, mkdir, unlink } from 'node:fs/promises';
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
const PAUSE_SIGNAL_PATH = join(TASK_DIR, 'pause.signal');

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Check if a pause.signal file was written by the host (world.ts /pause --task).
 * If found, delete it and return its contents. Returns null if none pending.
 */
const readAndClearPauseSignal = async () => {
  try {
    const raw = await readFile(PAUSE_SIGNAL_PATH, 'utf-8');
    const data = JSON.parse(raw);
    await unlink(PAUSE_SIGNAL_PATH).catch(() => undefined);
    return data;
  } catch {
    return null;
  }
};

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
    `             status ("in-progress"|"completed"|"failed"|"waiting_for_human"), summary,`,
    `             percentComplete (0-100), checkpoints: [{time, message}], artifacts?: {},`,
    `             question?: string (only when status is "waiting_for_human") }`,
    `   IMPORTANT: Update progress.json after each meaningful action so the human operator`,
    `   can monitor your progress in real-time. Aim for an update every 2-5 tool calls.`,
    `3. Poll for human instructions in: world/tasks/${TASK_ID}/inbox.json`,
    `   If inbox has messages, acknowledge them and incorporate the guidance before continuing.`,
    `4. When done: write status "completed" (or "failed") in progress.json.`,
    ``,
    `### Human Alignment Protocol (use sparingly, only for consequential blockers)`,
    `If you are uncertain about a decision that is CONSEQUENTIAL and you cannot proceed without`,
    `the human's input:`,
    `1. Write progress.json with status "waiting_for_human", a "question" field describing`,
    `   exactly what you need clarity on, and percentComplete set to current progress.`,
    `2. STOP immediately. Do NOT write anything else. Do NOT continue the task.`,
    `The system will pause you, show your question to the operator, and re-launch you with`,
    `their answer in your inbox. You will then continue from where you left off.`,
    ``,
    `When NOT to request alignment:`,
    `- Minor stylistic or implementation choices — use your judgment.`,
    `- Anything that you can reasonably infer from the task description.`,
    `- Questions you could answer yourself with a bit of research.`,
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

// ─── v2 subagent prompt ────────────────────────────────────────────────────────

const buildV2Prompt = () => {
  const base = buildPrompt();
  const members = ASSIGNED_TO.filter((id) => id !== LEADER_ID);
  const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = [
    base,
    ``,
    `## Execution Model: v2 — Leader + Subagents`,
    ``,
    `You are ${LEADER_ID}, the team leader. For this task you MUST use Claude's built-in`,
    `\`Task\` tool to spawn each team member as an independent subagent.`,
    `Each subagent runs as a real separate AI process that shares this container's filesystem.`,
    ``,
    `Team members to spawn: ${members.length > 0 ? members.join(', ') : '(solo task — no subagents needed)'}`,
    ``,
    `### Spawning pattern`,
    `Use the Task tool with a prompt like:`,
    `  "You are {member}. You are working on Vibe Guild task ${TASK_ID}: ${TASK_TITLE}.`,
    `   Your role: [describe their specific contribution].`,
    `   The workspace is at /workspace. Write your deliverables there.`,
    `   Your being directory: world/beings/{member}/.`,
    `   When done, write your self-note to world/beings/{member}/memory/self-notes/${ts}.json`,
    `   and update world/beings/{member}/profile.json (set status to idle, lastTaskId=${TASK_ID})."`,
    ``,
    `You may spawn subagents sequentially (if they depend on each other's output) or`,
    `concurrently (if they work independently). Use your judgment.`,
    ``,
    `Continue to write progress.json yourself after each significant milestone.`,
  ];
  return lines.join('\n');
};

// ─── claude invocation ────────────────────────────────────────────────────────

/**
 * Spawn the Claude CLI with the given prompt. Concurrently polls for pause.signal
 * (written by world.ts when the operator runs /pause --task).
 *
 * Returns 'done' if Claude exits cleanly, or 'paused' if a pause signal was
 * detected and the process was killed — no LLM cooperation required.
 *
 * @param {string} prompt
 * @returns {Promise<'done' | 'paused'>}
 */
const runClaudeInterruptible = async (prompt) => {
  const modelArgs = process.env['ANTHROPIC_MODEL']
    ? ['--model', process.env['ANTHROPIC_MODEL']]
    : [];
  const proc = spawn(
    'claude',
    ['--dangerously-skip-permissions', ...modelArgs, '-p', prompt],
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

  let killed = false;
  let done = false;

  /** @type {Promise<'done' | 'paused'>} */
  const claudeFinished = new Promise((resolve, reject) => {
    proc.on('close', (code) => {
      done = true;
      if (killed) resolve('paused');
      else if (code === 0) resolve('done');
      else reject(new Error(`claude exited with code ${code}`));
    });
  });

  // Concurrent poller: checks for pause.signal every 2 s while Claude runs.
  // Fire-and-forget — resolves only by side-effect (killing proc).
  void (async () => {
    while (!done) {
      await new Promise((r) => setTimeout(r, 2000));
      if (done) break;
      const sig = await readAndClearPauseSignal();
      if (sig) {
        console.log(`[sandbox] ⏸ Pause signal received ("${sig.message ?? ''}"). Stopping Claude…`);
        killed = true;
        proc.kill('SIGTERM');
        break;
      }
    }
  })();

  return claudeFinished;
};

/**
 * Block until inbox.json receives at least one message, then drain and return them joined.
 * Returns null if the timeout (ms) expires with no response.
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
const waitForInboxResponse = async (timeoutMs) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const msgs = await drainInbox();
    if (msgs.length > 0) return msgs.join('\n');
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
};

/**
 * Build the continuation prompt used when re-launching after a waiting_for_human pause.
 * @param {string} humanAnswer  The latest human message
 * @param {object} prevProgress  The progress snapshot that triggered alignment
 * @param {Array<{question: string, answer: string}>} history  All prior alignment turns
 * @returns {string}
 */
const buildResumePrompt = (humanAnswer, prevProgress, history) => {
  const base = EXECUTION_MODE === 'v2' ? buildV2Prompt() : buildPrompt();
  const historyLines = history.length > 1
    ? [
        ``,
        `--- ALIGNMENT CONVERSATION HISTORY ---`,
        ...history.slice(0, -1).flatMap(({ question, answer }) => [
          `Leader asked: "${question}"`,
          `Operator replied: "${answer}"`,
          ``,
        ]),
        `---`,
      ]
    : [];
  return [
    base,
    ...historyLines,
    ``,
    `--- OPERATOR RESPONSE ---`,
    `You previously paused to request human alignment. The operator has responded:`,
    ``,
    `Your question was: "${prevProgress?.question ?? prevProgress?.summary ?? '(unknown)'}"`,
    `Operator says: "${humanAnswer}"`,
    ``,
    `Your progress before pausing: ${prevProgress?.percentComplete ?? 0}% — ${prevProgress?.summary ?? 'unknown'}`,
    ``,
    `If this response is sufficient: resume the task by writing status="in-progress" to progress.json,`,
    `then CONTINUE from where you stopped. Do NOT restart.`,
    ``,
    `If you still need clarification: write status="waiting_for_human" again with a new "question" field.`,
    `Keep follow-ups concise and specific. You can exchange multiple messages before continuing.`,
    `---`,
  ].join('\n');
};

// ─── main ─────────────────────────────────────────────────────────────────────

const EXECUTION_MODE = process.env['EXECUTION_MODE'] ?? 'v1';

/**
 * Max alignment rounds as a safety brake (not a UX limit).
 * Each round = operator sends one or more messages, leader processes and either
 * asks a follow-up or resumes. Set high so natural conversations are not cut off.
 */
const MAX_ALIGNMENT_ROUNDS = 20;

const run = async () => {
  if (!TASK_ID) {
    console.error('[sandbox] TASK_ID is not set. Exiting.');
    process.exit(1);
  }

  console.log(`[sandbox] Starting task ${TASK_ID.slice(0, 8)}: ${TASK_TITLE} (mode: ${EXECUTION_MODE})`);
  await writeProgress('in-progress', 'Sandbox agent starting…', 0);

  // Check for any messages already in inbox before launching claude
  const initialMsgs = await drainInbox();
  const basePrompt = EXECUTION_MODE === 'v2' ? buildV2Prompt() : buildPrompt();
  const firstPrompt = initialMsgs.length > 0
    ? `${basePrompt}\n\n--- INITIAL INSTRUCTIONS FROM OPERATOR ---\n${initialMsgs.map((m) => `> ${m}`).join('\n')}\n---`
    : basePrompt;

  // ── First run ────────────────────────────────────────────────────────────
  const firstResult = await runClaudeInterruptible(firstPrompt);

  // If the host interrupted Claude via pause.signal, we own the waiting_for_human
  // state. Write it ourselves so the alignment loop below can pick it up.
  if (firstResult === 'paused') {
    const pausedProgress = await safeReadJson(join(TASK_DIR, 'progress.json'));
    const pauseMsgs = await drainInbox(); // grab the MEETUP msg for context (and clear it)
    const pauseContext = pauseMsgs.length > 0 ? pauseMsgs.join(' ') : 'Creator requested alignment via /pause --task';
    await writeProgress(
      'waiting_for_human',
      'Paused by creator for alignment',
      pausedProgress?.percentComplete ?? 0,
      { question: pauseContext },
    );
    console.log(`[sandbox] Written waiting_for_human. Entering alignment loop.`);
  }

  // ── Human alignment conversation loop ────────────────────────────────────
  // The leader writes waiting_for_human when it needs operator input.
  // The host (world.ts) stays unpaused and routes terminal input to inbox.json.
  // Each time the operator sends a message, entrypoint re-launches Claude with
  // the full conversation history so the leader can ask follow-ups or confirm.
  // The loop exits when leader writes any status other than waiting_for_human.
  //
  // Timeout per message wait: 30 min. Safety cap: MAX_ALIGNMENT_ROUNDS rounds.
  /** @type {Array<{question: string, answer: string}>} */
  const alignHistory = [];

  for (let round = 0; round < MAX_ALIGNMENT_ROUNDS; round++) {
    const progress = await safeReadJson(join(TASK_DIR, 'progress.json'));
    if (!progress || progress.status !== 'waiting_for_human') break;

    // Drain any stale inbox messages (e.g. the MEETUP REQUEST that triggered this alignment)
    // before we start polling for the human's actual reply.
    await drainInbox();

    const question = progress.question ?? progress.summary ?? '(no question provided)';
    console.log(`[sandbox] Alignment round ${round + 1}: "${question}"`);
    console.log(`[sandbox] Waiting for operator message (timeout: 30 min)…`);

    const answer = await waitForInboxResponse(30 * 60 * 1000);
    if (!answer) {
      console.error('[sandbox] Timed out waiting for human alignment. Marking task failed.');
      await writeProgress(
        'failed',
        `Timed out waiting for operator response to: "${question}"`,
        progress.percentComplete ?? 0,
      );
      process.exit(1);
    }

    alignHistory.push({ question, answer });
    console.log(`[sandbox] Operator message received. Re-launching leader with full conversation.`);
    await writeProgress('in-progress', 'Processing operator response…', progress.percentComplete ?? 0);
    const resumeResult = await runClaudeInterruptible(buildResumePrompt(answer, progress, alignHistory));
    // Handle mid-run pause during a resume session
    if (resumeResult === 'paused') {
      const pausedProgress = await safeReadJson(join(TASK_DIR, 'progress.json'));
      const pauseMsgs = await drainInbox();
      const pauseContext = pauseMsgs.length > 0 ? pauseMsgs.join(' ') : 'Creator requested alignment via /pause --task';
      await writeProgress(
        'waiting_for_human',
        'Paused by creator for alignment (mid-resume)',
        pausedProgress?.percentComplete ?? 0,
        { question: pauseContext },
      );
    }
  }

  // ── Final progress sync ──────────────────────────────────────────────────
  // (leader may have already written completed — that's fine)
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
