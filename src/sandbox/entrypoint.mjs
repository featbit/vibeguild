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
 *   VIBEGUILD_GITHUB_TOKEN  — required in docker mode; task repo creation/push
 *
 * The workspace is mounted at /workspace; world/ lives at /workspace/world/.
 */

import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdir, unlink, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getMcpServers } from './mcp-servers.mjs';

const TASK_ID = process.env['TASK_ID'] ?? '';
const TASK_TITLE = decodeURIComponent(process.env['TASK_TITLE'] ?? 'Untitled task');
const TASK_DESCRIPTION = decodeURIComponent(process.env['TASK_DESCRIPTION'] ?? '');
const LEADER_ID = process.env['LEADER_ID'] ?? 'leader';
const ASSIGNED_TO = (process.env['ASSIGNED_TO'] ?? LEADER_ID).split(',').map(s => s.trim()).filter(Boolean);
const GITHUB_TOKEN = process.env['VIBEGUILD_GITHUB_TOKEN'] ?? '';
const GITHUB_OWNER = process.env['VIBEGUILD_GITHUB_ORG'] ?? 'vibeguild';
let SANDBOX_REPO_URL = '';
const TASK_DETAIL_DIR = process.env['TASK_DETAIL_DIR'] ?? `runtime-details/${TASK_ID}`;

const WORKSPACE = '/workspace';
const WORLD_ROOT = join(WORKSPACE, 'world');
const TASK_DIR = join(WORLD_ROOT, 'tasks', TASK_ID);
const PAUSE_SIGNAL_PATH = join(TASK_DIR, 'pause.signal');
const PROGRESS_PATH = join(TASK_DIR, 'progress.json');
const LOGS_DIR = join(TASK_DIR, 'logs');
const CLAUDE_LOG_PATH = join(LOGS_DIR, 'claude-code.log');

const appendClaudeLog = async (stream, text) => {
  const ts = new Date().toISOString();
  await mkdir(LOGS_DIR, { recursive: true });
  await appendFile(CLAUDE_LOG_PATH, `[${ts}] [${stream}] ${text}\n`, 'utf-8');
};

const repoSlug = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';

const taskRepoPrefix = () => `task-${repoSlug(TASK_TITLE)}`;
const exactTaskRepoName = () => `${taskRepoPrefix()}-${TASK_ID.slice(0, 8)}`;

const ghFetch = async (url, init = {}) => {
  if (!GITHUB_TOKEN) throw new Error('VIBEGUILD_GITHUB_TOKEN is missing in sandbox env.');
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  });
  return res;
};

const getRepoIfExists = async (owner, repo) => {
  const res = await ghFetch(`https://api.github.com/repos/${owner}/${repo}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub read repo failed: ${res.status} — ${body}`);
  }
  return res.json();
};

const listCandidateRepos = async (owner, prefix) => {
  const res = await ghFetch(`https://api.github.com/orgs/${owner}/repos?type=private&per_page=100&sort=updated`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub list repos failed: ${res.status} — ${body}`);
  }
  const repos = await res.json();
  return Array.isArray(repos) ? repos.filter((r) => String(r?.name ?? '').startsWith(prefix)) : [];
};

const createRepo = async (ownerOrNull, name) => {
  const body = {
    name,
    description: `Vibe Guild execution sandbox for task ${TASK_ID}: ${TASK_TITLE}`,
    private: true,
    auto_init: true,
  };
  const url = ownerOrNull
    ? `https://api.github.com/orgs/${ownerOrNull}/repos`
    : 'https://api.github.com/user/repos';
  const res = await ghFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub create repo failed: ${res.status} — ${txt}`);
  }
  return res.json();
};

const resolveSandboxRepo = async () => {
  const exactName = exactTaskRepoName();
  const prefix = taskRepoPrefix();
  await appendClaudeLog('system', `Resolving task repo by exact name ${exactName} or prefix ${prefix}-*`);

  const exact = await getRepoIfExists(GITHUB_OWNER, exactName).catch(() => null);
  if (exact?.html_url) {
    SANDBOX_REPO_URL = exact.html_url;
    await appendClaudeLog('system', `Resolved existing exact repo: ${SANDBOX_REPO_URL}`);
    return SANDBOX_REPO_URL;
  }

  try {
    const candidates = await listCandidateRepos(GITHUB_OWNER, prefix);
    if (candidates.length > 0) {
      SANDBOX_REPO_URL = String(candidates[0].html_url ?? '');
      if (SANDBOX_REPO_URL) {
        await appendClaudeLog('system', `Reusing latest repo by prefix: ${SANDBOX_REPO_URL}`);
        return SANDBOX_REPO_URL;
      }
    }
  } catch (err) {
    await appendClaudeLog('system', `Org repo listing failed (${GITHUB_OWNER}): ${err?.message ?? err}`);
  }

  try {
    const created = await createRepo(GITHUB_OWNER, exactName);
    SANDBOX_REPO_URL = String(created?.html_url ?? '');
    if (SANDBOX_REPO_URL) {
      await appendClaudeLog('system', `Created org repo: ${SANDBOX_REPO_URL}`);
      return SANDBOX_REPO_URL;
    }
  } catch (err) {
    await appendClaudeLog('system', `Org repo create failed (${GITHUB_OWNER}): ${err?.message ?? err}`);
  }

  const createdUser = await createRepo(null, exactName);
  SANDBOX_REPO_URL = String(createdUser?.html_url ?? '');
  if (!SANDBOX_REPO_URL) throw new Error('GitHub repo creation succeeded but html_url is empty.');
  await appendClaudeLog('system', `Created user repo fallback: ${SANDBOX_REPO_URL}`);
  return SANDBOX_REPO_URL;
};

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
  const current = await safeReadJson(PROGRESS_PATH);
  const baseCheckpoints = Array.isArray(current?.checkpoints) ? current.checkpoints : [];
  const checkpointDescription = typeof extra?.checkpointDescription === 'string'
    ? extra.checkpointDescription
    : null;
  const checkpoints = checkpointDescription
    ? [...baseCheckpoints, { at: new Date().toISOString(), description: checkpointDescription }]
    : baseCheckpoints;
  const { checkpointDescription: _checkpointDescription, ...extraFields } = extra;

  /** @type {Record<string, unknown>} */
  const payload = {
    ...(current && typeof current === 'object' ? current : {}),
    taskId: TASK_ID,
    leaderId: LEADER_ID,
    worldDay,
    reportedAt: new Date().toISOString(),
    status,
    summary,
    percentComplete: percent,
    checkpoints,
    ...(SANDBOX_REPO_URL ? { sandboxRepoUrl: SANDBOX_REPO_URL } : {}),
    ...extraFields,
  };

  if (status !== 'waiting_for_human' && 'question' in payload) {
    delete payload.question;
  }

  await mkdir(TASK_DIR, { recursive: true });
  await writeFile(PROGRESS_PATH, JSON.stringify(payload, null, 2), 'utf-8');
};

const hasExecutionEvidence = (progress) => {
  if (!progress || typeof progress !== 'object') return false;
  const checkpoints = Array.isArray(progress.checkpoints) ? progress.checkpoints : [];
  const meaningfulCheckpoints = checkpoints.filter((cp) => {
    const text = String(cp?.description ?? '');
    return text.length > 0 && !/sandbox agent starting|sandbox run started|sandbox run finished|paused by creator|auto-validation/i.test(text);
  });
  if (meaningfulCheckpoints.length > 0) return true;

  const summary = String(progress.summary ?? '').trim();
  const isDefaultSummary = summary === 'Sandbox agent starting…' || summary === 'Sandbox agent finished execution.';
  const percent = Number(progress.percentComplete ?? 0);
  return summary.length > 0 && !isDefaultSummary && percent >= 10;
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
    `### Shared skills`,
    `Before starting, read any skill files in world/shared/skills/ (if the directory exists).`,
    `These are operator-authored best practices for this world — follow them throughout the task.`,
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
      `Create and continuously update a details folder in that repo: ${TASK_DETAIL_DIR}/`,
      `Required files in ${TASK_DETAIL_DIR}/:`,
      `  - claude-code.log (raw runtime log excerpts)`,
      `  - progress-snapshots.ndjson (append each milestone snapshot)`,
      `  - artifacts-manifest.md (what was produced and where)`,
      `Sync this folder to GitHub repeatedly during execution, not only at the end.`,
      `Also mirror logs from world/tasks/${TASK_ID}/logs/ when relevant.`,
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

// ─── MCP config ───────────────────────────────────────────────────────────────

/**
 * Write /tmp/vibeguild-mcp.json from the world-shared server definitions
 * (src/sandbox/mcp-servers.mjs) and return the config file path.
 *
 * @returns {Promise<string>}
 */
const setupMcpConfig = async () => {
  const hardcoded = getMcpServers(process.env);

  // Merge with operator-added dynamic servers from world/shared/mcp-servers.json.
  // Dynamic entries override hardcoded ones if names collide.
  let dynamic = {};
  try {
    const raw = await readFile('/workspace/world/shared/mcp-servers.json', 'utf-8');
    dynamic = JSON.parse(raw);
  } catch {
    // File doesn't exist or isn't valid JSON — use only hardcoded servers
  }

  const merged = { ...hardcoded, ...dynamic };
  const mcpServers = Object.fromEntries(
    Object.entries(merged).map(([name, raw]) => {
      const cfg = raw && typeof raw === 'object' ? { ...raw } : {};

      if (!cfg.type && typeof cfg.transport === 'string') {
        const transport = String(cfg.transport).toLowerCase();
        if (transport === 'http' || transport === 'streamablehttp') cfg.type = 'http';
        else if (transport === 'sse') cfg.type = 'sse';
        else if (transport === 'stdio') cfg.type = 'stdio';
      }

      if (!cfg.type && typeof cfg.command === 'string') cfg.type = 'stdio';
      if (!cfg.type && typeof cfg.url === 'string') cfg.type = 'http';

      if ('transport' in cfg) delete cfg.transport;
      return [name, cfg];
    }),
  );
  const config = { mcpServers };
  const configPath = '/tmp/vibeguild-mcp.json';
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`[sandbox] MCP config written: ${configPath} (${Object.keys(mcpServers).length} server(s))`);
  return configPath;
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
 * @param {string|null} [mcpConfigPath]
 * @param {boolean} [allowMcpSilentFallback]
 * @param {number} [timeoutMs]
 * @returns {Promise<'done' | 'paused'>}
 */
const runClaudeInterruptible = async (prompt, mcpConfigPath = null, allowMcpSilentFallback = true, timeoutMs = 0) => {
  const modelArgs = process.env['ANTHROPIC_MODEL']
    ? ['--model', process.env['ANTHROPIC_MODEL']]
    : [];
  const mcpArgs = mcpConfigPath ? ['--mcp-config', mcpConfigPath] : [];
  await appendClaudeLog('system', `Launching Claude with model=${process.env['ANTHROPIC_MODEL'] ?? 'default'} mcpConfig=${mcpConfigPath ?? 'none'}`);
  const proc = spawn(
    'claude',
    ['--dangerously-skip-permissions', ...modelArgs, ...mcpArgs, '-p', prompt],
    {
      cwd: WORKSPACE,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    },
  );

  proc.stdout?.on('data', (/** @type {Buffer} */ d) => {
    const text = d.toString();
    process.stdout.write(`[${LEADER_ID}] ${text}`);
    void appendClaudeLog('stdout', text.trimEnd()).catch(() => undefined);
  });
  proc.stderr?.on('data', (/** @type {Buffer} */ d) => {
    const text = d.toString();
    process.stderr.write(`[${LEADER_ID}:err] ${text}`);
    void appendClaudeLog('stderr', text.trimEnd()).catch(() => undefined);
  });

  let pauseKilled = false;
  let timeoutKilled = false;
  let done = false;
  let sawStdout = false;
  let sawStderr = false;
  const hardTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
  let timeoutHandle = null;

  proc.stdout?.on('data', (/** @type {Buffer} */ d) => {
    if (d.toString().trim().length > 0) sawStdout = true;
  });

  proc.stderr?.on('data', (/** @type {Buffer} */ d) => {
    if (d.toString().trim().length > 0) sawStderr = true;
  });

  /** @type {Promise<'done' | 'paused'>} */
  const claudeFinished = new Promise((resolve, reject) => {
    proc.on('close', async (code) => {
      done = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      void appendClaudeLog('system', `Claude process exited code=${code} killedByPause=${pauseKilled} killedByTimeout=${timeoutKilled}`).catch(() => undefined);
      if (pauseKilled) {
        resolve('paused');
        return;
      }

      if (timeoutKilled) {
        reject(new Error(`claude timed out after ${hardTimeoutMs}ms`));
        return;
      }

      if (code === 0) {
        const mcpSilentExit = mcpConfigPath && allowMcpSilentFallback && !sawStdout && !sawStderr;
        if (mcpSilentExit) {
          const progress = await safeReadJson(PROGRESS_PATH);
          const hasEvidence = hasExecutionEvidence(progress);
          const status = String(progress?.status ?? '');
          const shouldRetryWithoutMcp = !hasEvidence && status !== 'completed' && status !== 'waiting_for_human';

          if (shouldRetryWithoutMcp) {
            const warning = 'Claude exited 0 with no stdout/stderr while MCP was enabled; retrying once without --mcp-config.';
            console.warn(`[sandbox] ${warning}`);
            await appendClaudeLog('system', warning);
            runClaudeInterruptible(prompt, null, false).then(resolve).catch(reject);
            return;
          }
        }

        resolve('done');
        return;
      }

      reject(new Error(`claude exited with code ${code}`));
    });
  });

  if (hardTimeoutMs > 0) {
    timeoutHandle = setTimeout(async () => {
      if (done) return;
      timeoutKilled = true;
      const timeoutMsg = `Claude hard timeout reached (${hardTimeoutMs}ms); sending SIGTERM.`;
      console.error(`[sandbox] ${timeoutMsg}`);
      await appendClaudeLog('system', timeoutMsg).catch(() => undefined);
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!done) proc.kill('SIGKILL');
      }, 5000);
    }, hardTimeoutMs);
  }

  // Concurrent poller: checks for pause.signal every 2 s while Claude runs.
  // Fire-and-forget — resolves only by side-effect (killing proc).
  void (async () => {
    while (!done) {
      await new Promise((r) => setTimeout(r, 2000));
      if (done) break;
      const sig = await readAndClearPauseSignal();
      if (sig) {
        console.log(`[sandbox] ⏸ Pause signal received ("${sig.message ?? ''}"). Stopping Claude…`);
        await appendClaudeLog('system', `Pause signal received: ${sig.message ?? ''}`);
        pauseKilled = true;
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
    `MANDATORY: You MUST write status="waiting_for_human" to respond to the operator before doing anything else.`,
    `In your "question" field, write your acknowledgment of their message and confirm your updated plan,`,
    `then ask: "Shall I proceed, or do you have more guidance?"`,
    ``,
    `Only write status="in-progress" (and resume the task) when the operator explicitly says to proceed`,
    `(e.g. "ok go ahead", "proceed", "/done") or when they have no more questions.`,
    ``,
    `Do NOT silently resume — always acknowledge first and wait for confirmation.`,
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
const MAX_NOOP_RETRY = 1;
const ALIGNMENT_RESUME_TIMEOUT_MS = 5 * 60 * 1000;

const run = async () => {
  if (!TASK_ID) {
    console.error('[sandbox] TASK_ID is not set. Exiting.');
    process.exit(1);
  }

  if (!GITHUB_TOKEN) {
    const reason = 'VIBEGUILD_GITHUB_TOKEN is required in sandbox for task repo resolution.';
    await writeProgress('failed', reason, 0, { checkpointDescription: 'Sandbox startup failed: missing GitHub token' });
    await appendClaudeLog('system', reason);
    console.error(`[sandbox] ${reason}`);
    process.exit(1);
  }

  console.log(`[sandbox] Starting task ${TASK_ID.slice(0, 8)}: ${TASK_TITLE} (mode: ${EXECUTION_MODE})`);
  try {
    await resolveSandboxRepo();
  } catch (err) {
    const reason = `Task repo resolution failed: ${err?.message ?? err}`;
    await writeProgress('failed', reason, 0, { checkpointDescription: 'Sandbox startup failed: repo resolution failed' });
    await appendClaudeLog('system', reason);
    console.error(`[sandbox] ${reason}`);
    process.exit(1);
  }

  await writeProgress('in-progress', 'Sandbox agent starting…', 0, {
    checkpointDescription: 'Sandbox run started',
  });

  // Set up world-shared MCP servers (web search, etc.) before launching claude
  const mcpConfigPath = await setupMcpConfig();

  // Check for any messages already in inbox before launching claude
  const initialMsgs = await drainInbox();
  const basePrompt = EXECUTION_MODE === 'v2' ? buildV2Prompt() : buildPrompt();
  const firstPrompt = initialMsgs.length > 0
    ? `${basePrompt}\n\n--- INITIAL INSTRUCTIONS FROM OPERATOR ---\n${initialMsgs.map((m) => `> ${m}`).join('\n')}\n---`
    : basePrompt;

  /** @type {'done' | 'paused'} */
  let runResult = await runClaudeInterruptible(firstPrompt, mcpConfigPath);

  // If the host interrupted Claude via pause.signal, we own the waiting_for_human
  // state. Write it ourselves so the alignment loop below can pick it up.
  if (runResult === 'paused') {
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
    // Do NOT write in-progress here — that would immediately exit world.ts alignment mode.
    // Let Claude decide: write waiting_for_human (acknowledgment/follow-up) or in-progress (proceed).
    const resumePrompt = buildResumePrompt(answer, progress, alignHistory);
    let resumeResult;
    try {
      resumeResult = await runClaudeInterruptible(
        resumePrompt,
        mcpConfigPath,
        true,
        ALIGNMENT_RESUME_TIMEOUT_MS,
      );
    } catch (err) {
      const firstErr = err instanceof Error ? err.message : String(err);
      const warn = `Alignment resume with MCP failed (${firstErr}); retrying once without MCP.`;
      console.error(`[sandbox] ${warn}`);
      await appendClaudeLog('system', warn);
      await writeProgress(
        'waiting_for_human',
        'Alignment resume stalled; auto-retrying once without MCP.',
        progress.percentComplete ?? 0,
        { question },
      );

      try {
        resumeResult = await runClaudeInterruptible(
          resumePrompt,
          null,
          false,
          ALIGNMENT_RESUME_TIMEOUT_MS,
        );
      } catch (retryErr) {
        const secondErr = retryErr instanceof Error ? retryErr.message : String(retryErr);
        const reason = `Alignment resume failed after MCP fallback: ${secondErr}`;
        console.error(`[sandbox] ${reason}`);
        await appendClaudeLog('system', reason);
        await writeProgress(
          'failed',
          reason,
          progress.percentComplete ?? 0,
          { checkpointDescription: 'Alignment resume failed after MCP fallback' },
        );
        process.exit(1);
      }
    }

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
  const current = await safeReadJson(PROGRESS_PATH);
  if (!current) {
    await writeProgress('failed', 'Sandbox exited without progress evidence.', 0, {
      checkpointDescription: 'Auto-validation failed: progress.json missing',
    });
    console.error('[sandbox] Missing progress.json at end of run. Marking failed.');
    process.exit(1);
  }

  if (current.status === 'completed') {
    console.log(`[sandbox] Task ${TASK_ID.slice(0, 8)} done.`);
    return;
  }

  if (current.status === 'failed' || current.status === 'blocked') {
    console.error(`[sandbox] Task ended with status=${current.status}.`);
    process.exit(1);
  }

  if (current.status === 'waiting_for_human') {
    await writeProgress('failed', 'Sandbox exited while still waiting for human response.', Number(current.percentComplete ?? 0), {
      checkpointDescription: 'Auto-validation failed: still waiting_for_human at process end',
    });
    console.error('[sandbox] Still waiting_for_human at process end. Marking failed.');
    process.exit(1);
  }

  if (!hasExecutionEvidence(current)) {
    let recovered = false;
    for (let attempt = 1; attempt <= MAX_NOOP_RETRY; attempt++) {
      const remediationPrompt = [
        EXECUTION_MODE === 'v2' ? buildV2Prompt() : buildPrompt(),
        '',
        '--- REMEDIATION ---',
        'Your previous run exited without meaningful progress evidence.',
        'You MUST now perform at least one concrete task action and then update progress.json with a meaningful checkpoint.',
        'Also ensure the required artifact is written if requested by the task description.',
        'Do not exit immediately. Complete the task or write failed with explicit reason.',
      ].join('\n');

      await appendClaudeLog('system', `No-op recovery attempt ${attempt}/${MAX_NOOP_RETRY}`);
      const retryResult = await runClaudeInterruptible(remediationPrompt, mcpConfigPath);

      if (retryResult === 'paused') {
        const pausedProgress = await safeReadJson(join(TASK_DIR, 'progress.json'));
        const pauseMsgs = await drainInbox();
        const pauseContext = pauseMsgs.length > 0 ? pauseMsgs.join(' ') : 'Creator requested alignment via /pause --task';
        await writeProgress(
          'waiting_for_human',
          'Paused by creator during remediation',
          pausedProgress?.percentComplete ?? 0,
          { question: pauseContext },
        );
      }

      const afterRetry = await safeReadJson(PROGRESS_PATH);
      if (hasExecutionEvidence(afterRetry)) {
        recovered = true;
        break;
      }
    }

    if (!recovered) {
      await writeProgress('failed', 'Sandbox exited without meaningful execution evidence.', Number(current.percentComplete ?? 0), {
        checkpointDescription: 'Auto-validation failed: no meaningful checkpoints',
      });
      console.error('[sandbox] No meaningful execution evidence. Marking failed.');
      process.exit(1);
    }
  }

  await writeProgress('completed', 'Sandbox agent finished execution.', 100, {
    checkpointDescription: 'Sandbox run finished',
  });

  console.log(`[sandbox] Task ${TASK_ID.slice(0, 8)} done.`);
};

run().catch(async (err) => {
  console.error('[sandbox] Fatal error:', err.message ?? err);
  await writeProgress('failed', `Sandbox error: ${err.message ?? err}`, 0).catch(() => undefined);
  process.exit(1);
});
