/**
 * Cron scheduler — fires registered CronJobs on schedule, creating Tasks.
 *
 * Schedule kinds:
 *   "cron"  → delegated to node-cron (exact expression, optional TZ)
 *   "every" → polled every 30 s against nextRunAtMs (ms interval)
 *   "at"    → polled every 30 s, fires once when past the ISO timestamp
 *
 * Inspired by openclaw's CronService pattern: jobs are persisted in a JSON
 * store, and firing a job enqueues a fresh Task into the world queue.
 *
 * Execution isolation:
 *   Cron jobs create Tasks, which run via the world's configured adapter.
 *   Set RUNTIME_MODE=docker so each job fire runs in its own Docker sandbox —
 *   fully isolated from the host filesystem. Recommended for production.
 *
 * All imports use ESM `import` syntax. No `require` anywhere.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { schedule as cronSchedule, validate as cronValidate } from 'node-cron';
import type { ScheduledTask } from 'node-cron';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRONS_DIR = join(__dirname, '..', '..', 'world', 'crons');
const execFileAsync = promisify(execFile);
import {
  listCronJobs,
  markJobFired,
  deleteAfterFired,
  setCronJobState,
  setCronJobDiscordThread,
} from './store.js';
import { enqueueTask } from '../tasks/queue.js';
import {
  createCronJobThread,
  notifyCronJob,
  registerCronJobThread,
} from '../discord.js';
import type { CronJob, CronPayloadDocker } from './types.js';

// ─── Internal state ────────────────────────────────────────────────────────────

type CronEntry = { jobId: string; task: ScheduledTask };

const cronEntries: CronEntry[] = [];
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let reloadTimer: ReturnType<typeof setInterval> | null = null;

// ─── Discord thread helpers ────────────────────────────────────────────────────

/** Ensure a Discord forum post exists for a cron job. Creates it if missing. */
const ensureDiscordThread = async (job: CronJob): Promise<void> => {
  // Restore from persisted state first (survives restarts)
  if (job.state.discordThreadId) {
    registerCronJobThread(job.id, job.state.discordThreadId);
    return;
  }
  // Create a new thread
  const threadId = await createCronJobThread({
    id: job.id,
    name: job.name,
    description: job.description,
    enabled: job.enabled,
    runtime: job.runtime,
    schedule: job.schedule,
    payload: job.payload,
    state: job.state,
  });
  if (threadId) {
    await setCronJobDiscordThread(job.id, threadId);
  }
};

const formatRunSummary = (
  job: CronJob,
  taskId: string,
  status: 'ok' | 'error',
  nextRunAtMs?: number,
): string => {
  const now = new Date().toISOString().slice(0, 19) + 'Z';
  const runNo = (job.state.runCount ?? 0) + 1;
  const icon = status === 'ok' ? '✅' : '❌';
  const lines = [
    `${icon} Run #${runNo} — ${now}`,
    `  Status : ${status}`,
    ...(taskId && job.runtime === 'docker' ? [`  Task   : \`${taskId.slice(0, 8)}\` "${(job.payload as CronPayloadDocker).title.slice(0, 60)}"`] : []),
    ...(nextRunAtMs ? [`  Next   : ${new Date(nextRunAtMs).toISOString().slice(0, 19)}Z`] : []),
  ];
  return lines.join('\n');
};

// ─── Core: fire a single job ───────────────────────────────────────────────────

const fireJob = async (job: CronJob): Promise<void> => {
  // ── Local runtime: execute world/crons/{id}/run.mjs, post stdout to Discord ──
  if (job.runtime === 'local') {
    const now = new Date().toISOString().slice(0, 19) + 'Z';
    const runNo = (job.state.runCount ?? 0) + 1;
    const nextRunAtMs =
      job.schedule.kind === 'every' ? Date.now() + job.schedule.everyMs : undefined;
    const scriptPath = join(CRONS_DIR, job.id, 'run.mjs');

    if (!existsSync(scriptPath)) {
      const msg = [
        `⚠️ Run #${runNo} — ${now}`,
        `  No script found at: world/crons/${job.id}/run.mjs`,
        `  @mention me in this thread to describe what you want — I'll write the script.`,
        ...(nextRunAtMs ? [`  Next   : ${new Date(nextRunAtMs).toISOString().slice(0, 19)}Z`] : []),
      ].join('\n');
      notifyCronJob(job.id, msg);
      await markJobFired(job.id, '', 'error', nextRunAtMs).catch(() => undefined);
      console.warn(`\n⚠️  [cron] Local job "${job.name}" — run.mjs not found, skipping`);
      return;
    }

    try {
      const { stdout, stderr } = await execFileAsync('node', [scriptPath], {
        timeout: 30_000,
        cwd: join(CRONS_DIR, job.id),
        env: process.env as NodeJS.ProcessEnv,
      });
      const output = [stdout.trim(), stderr.trim() ? `stderr: ${stderr.trim()}` : ''].filter(Boolean).join('\n');
      await markJobFired(job.id, '', 'ok', nextRunAtMs);
      const lines = [
        `✅ Run #${runNo} — ${now}`,
        ...(output
          ? [`  Output :\n${output.split('\n').map((l) => `    ${l}`).join('\n')}`]
          : ['  (no output)']),
        ...(nextRunAtMs ? [`  Next   : ${new Date(nextRunAtMs).toISOString().slice(0, 19)}Z`] : []),
      ];
      notifyCronJob(job.id, lines.join('\n'));
      if (job.schedule.kind === 'at' && job.deleteAfterRun !== false) {
        await deleteAfterFired(job.id);
      }
      console.log(`\n⏰ [cron] Local job "${job.name}" ran → ${output.slice(0, 80).replace(/\n/g, ' ')}`);
    } catch (err: unknown) {
      const e = err as { message?: string; stdout?: string; stderr?: string };
      const errOut = [e.stdout?.trim(), e.stderr?.trim(), e.message].filter(Boolean).join('\n');
      console.error(`\n❌ [cron] Local job "${job.name}" failed:`, errOut);
      await markJobFired(job.id, '', 'error', nextRunAtMs).catch(() => undefined);
      notifyCronJob(job.id, `❌ Run #${runNo} — ${now}\n  Error: ${errOut.slice(0, 500)}`);
    }
    return;
  }

  // ── Docker runtime: enqueue a full Task ────────────────────────────────
  const dockerPayload = job.payload as CronPayloadDocker;
  try {
    const task = await enqueueTask({
      title: dockerPayload.title,
      description: dockerPayload.description,
      priority: dockerPayload.priority,
      createdBy: 'cron',
      ...(job.state.discordThreadId ? { discordThreadId: job.state.discordThreadId } : {}),
    });

    // Compute next run for "every" jobs
    const nextRunAtMs =
      job.schedule.kind === 'every'
        ? Date.now() + job.schedule.everyMs
        : undefined;

    await markJobFired(job.id, task.id, 'ok', nextRunAtMs);

    // Post run summary to the job's Discord thread
    notifyCronJob(job.id, formatRunSummary(job, task.id, 'ok', nextRunAtMs));

    // One-shot "at" jobs are removed after success unless deleteAfterRun=false
    if (job.schedule.kind === 'at' && job.deleteAfterRun !== false) {
      await deleteAfterFired(job.id);
    }

    console.log(
      `\n⏰ [cron] Docker job "${job.name}" fired → task ${task.id.slice(0, 8)} "${task.title.slice(0, 60)}"`,
    );
  } catch (err) {
    console.error(`\n❌ [cron] Docker job "${job.name}" fire failed:`, err);
    await markJobFired(job.id, '', 'error').catch(() => undefined);
    notifyCronJob(job.id, formatRunSummary(job, '', 'error'));
  }
};

// ─── node-cron management (for schedule.kind === "cron") ─────────────────────

const unregisterCronJob = (jobId: string): void => {
  const idx = cronEntries.findIndex((e) => e.jobId === jobId);
  if (idx !== -1) {
    cronEntries[idx]!.task.stop();
    cronEntries.splice(idx, 1);
  }
};

const registerCronJob = (job: CronJob): void => {
  if (job.schedule.kind !== 'cron') return;

  const { expr, tz } = job.schedule;

  if (!cronValidate(expr)) {
    console.warn(
      `\n⚠️  [cron] Invalid cron expression for job "${job.name}": "${expr}" — skipped.`,
    );
    return;
  }

  // Remove any stale entry first
  unregisterCronJob(job.id);

  const task = cronSchedule(
    expr,
    () => { void fireJob(job); },
    { timezone: tz },
  );

  cronEntries.push({ jobId: job.id, task });
};

// ─── Polling tick (every / at jobs) ───────────────────────────────────────────

const pollJobs = async (): Promise<void> => {
  const now = Date.now();
  const jobs = await listCronJobs({ enabledOnly: true });

  for (const job of jobs) {
    if (job.schedule.kind === 'cron') continue; // handled by node-cron

    if (job.schedule.kind === 'at') {
      const atMs = new Date(job.schedule.at).getTime();
      const alreadyFired =
        job.state.lastRunAtMs !== undefined && job.state.lastRunAtMs >= atMs;
      if (!alreadyFired && now >= atMs) {
        await fireJob(job);
      }
      continue;
    }

    if (job.schedule.kind === 'every') {
      const nextMs = job.state.nextRunAtMs;
      if (nextMs !== undefined && now >= nextMs) {
        await fireJob(job);
      }
    }
  }
};

// ─── Reload cron entries + sync Discord threads ───────────────────────────────

const syncCronEntries = async (): Promise<void> => {
  const jobs = await listCronJobs({ enabledOnly: true });
  const activeIds = new Set(jobs.filter((j) => j.schedule.kind === 'cron').map((j) => j.id));
  const registeredIds = new Set(cronEntries.map((e) => e.jobId));

  // Remove stale node-cron entries
  for (const id of registeredIds) {
    if (!activeIds.has(id)) unregisterCronJob(id);
  }

  // Add new cron entries and ensure Discord threads
  for (const job of jobs) {
    if (job.schedule.kind === 'cron' && !registeredIds.has(job.id)) {
      registerCronJob(job);
    }
    void ensureDiscordThread(job);
  }
};

// ─── Public API ────────────────────────────────────────────────────────────────

/** * Fire a cron job immediately regardless of its schedule.
 * Handles both task and direct payloads correctly.
 * Returns the spawned task ID (task jobs) or null (direct jobs).
 */
export const fireJobNow = async (jobId: string): Promise<string | null> => {
  const jobs = await listCronJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return null;
  await fireJob(job);
  return job.runtime !== 'local' ? (job.state.lastTaskId ?? null) : null;
};

/** * Start the cron scheduler.
 * - Registers all enabled "cron" jobs with node-cron.
 * - Ensures each active job has a Discord forum post in #cron-jobs.
 * - Initialises `nextRunAtMs` for "every" jobs that have none yet.
 * - Polls every 30 s for "every"/"at" jobs.
 * - Reloads node-cron registrations every 60 s to pick up new jobs.
 */
export const startCronScheduler = async (): Promise<void> => {
  const jobs = await listCronJobs({ enabledOnly: true });

  // Register "cron" type jobs and create Discord threads
  for (const job of jobs) {
    if (job.schedule.kind === 'cron') registerCronJob(job);
    void ensureDiscordThread(job);
  }

  // Initialise nextRunAtMs for "every" jobs without one
  const now = Date.now();
  for (const job of jobs) {
    if (job.schedule.kind !== 'every') continue;
    if (job.state.nextRunAtMs !== undefined) continue;

    const anchor = job.schedule.anchorMs ?? now;
    const elapsed = now - anchor;
    const periods = Math.floor(elapsed / job.schedule.everyMs);
    const nextRunAtMs = anchor + (periods + 1) * job.schedule.everyMs;
    await setCronJobState(job.id, { nextRunAtMs });
  }

  // Polling timer for "every" / "at" jobs.
  // 5-second interval so sub-minute "every" jobs fire on time.
  pollingTimer = setInterval(() => { void pollJobs(); }, 5_000);

  // Periodic re-sync of node-cron entries (picks up /cron add/remove)
  reloadTimer = setInterval(() => { void syncCronEntries(); }, 60_000);

  const cronCount = cronEntries.length;
  const everyCount = jobs.filter((j) => j.schedule.kind === 'every').length;
  const atCount = jobs.filter((j) => j.schedule.kind === 'at').length;
  console.log(
    `\n⏰ [cron] Scheduler started — ${cronCount} cron, ${everyCount} every, ${atCount} at job(s).`,
  );
};

/** Stop the cron scheduler (inverse of startCronScheduler). */
export const stopCronScheduler = (): void => {
  for (const entry of cronEntries) entry.task.stop();
  cronEntries.length = 0;

  if (pollingTimer !== null) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
  if (reloadTimer !== null) {
    clearInterval(reloadTimer);
    reloadTimer = null;
  }

  console.log('\n⏰ [cron] Scheduler stopped.');
};

/**
 * Force-reload node-cron entries and Discord threads from the store immediately.
 * Call this right after programmatic /cron add or /cron remove so the
 * scheduler reflects the change without waiting for the 60-second timer.
 */
export const reloadCronScheduler = async (): Promise<void> => {
  await syncCronEntries();
};
