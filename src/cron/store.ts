/**
 * Cron job store — persists each job to its own folder: world/crons/{id}/job.json
 *
 * Structure mirrors the tasks store: one subfolder per job, allowing easy
 * per-job file additions (logs, output, etc.) in the future.
 */

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { CronJob, CronJobCreate, CronJobPatch, CronJobState } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRONS_DIR = join(__dirname, '..', '..', 'world', 'crons');

// ─── Low-level I/O ────────────────────────────────────────────────────────────

const jobPath = (id: string): string => join(CRONS_DIR, id, 'job.json');

const readJob = async (id: string): Promise<CronJob | null> => {
  try {
    const raw = await readFile(jobPath(id), 'utf-8');
    return JSON.parse(raw) as CronJob;
  } catch {
    return null;
  }
};

const writeJob = async (job: CronJob): Promise<void> => {
  const dir = join(CRONS_DIR, job.id);
  await mkdir(dir, { recursive: true });
  await writeFile(jobPath(job.id), JSON.stringify(job, null, 2), 'utf-8');
};

// ─── Exported helpers ─────────────────────────────────────────────────────────

export const listCronJobs = async (opts?: { enabledOnly?: boolean }): Promise<CronJob[]> => {
  try {
    const entries = await readdir(CRONS_DIR, { withFileTypes: true });
    const jobs: CronJob[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const job = await readJob(entry.name);
      if (job) jobs.push(job);
    }
    return opts?.enabledOnly ? jobs.filter((j) => j.enabled) : jobs;
  } catch {
    return [];
  }
};

export const getCronJob = async (id: string): Promise<CronJob | null> => readJob(id);

export const addCronJob = async (input: CronJobCreate): Promise<CronJob> => {
  const now = new Date().toISOString();
  const job: CronJob = {
    ...input,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    state: {},
  };
  await writeJob(job);
  return job;
};

export const updateCronJob = async (id: string, patch: CronJobPatch): Promise<CronJob | null> => {
  const job = await readJob(id);
  if (!job) return null;
  const updated: CronJob = {
    ...job,
    ...patch,
    id,
    createdAt: job.createdAt,
    state: job.state,
    updatedAt: new Date().toISOString(),
  };
  await writeJob(updated);
  return updated;
};

export const removeCronJob = async (id: string): Promise<boolean> => {
  try {
    await rm(join(CRONS_DIR, id), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
};

export const setCronJobState = async (id: string, state: Partial<CronJobState>): Promise<void> => {
  const job = await readJob(id);
  if (!job) return;
  job.state = { ...job.state, ...state };
  job.updatedAt = new Date().toISOString();
  await writeJob(job);
};

/** After a job fires: record the outcome and update next-run time for "every" jobs. */
export const markJobFired = async (
  id: string,
  taskId: string,
  status: 'ok' | 'error',
  nextRunAtMs?: number,
): Promise<void> => {
  const job = await readJob(id);
  if (!job) return;
  job.state = {
    discordThreadId: job.state.discordThreadId,  // preserve thread ID separately, not from spread
    lastRunAtMs: Date.now(),
    lastTaskId: taskId || undefined,
    lastStatus: status,
    runCount: (job.state.runCount ?? 0) + 1,
    ...(nextRunAtMs !== undefined ? { nextRunAtMs } : {}),
  };
  job.updatedAt = new Date().toISOString();
  await writeJob(job);
};

/** Remove a job's folder after it fires (for deleteAfterRun=true "at" jobs). */
export const deleteAfterFired = async (id: string): Promise<void> => {
  await removeCronJob(id);
};

/** Persist the Discord forum thread ID for a cron job. */
export const setCronJobDiscordThread = async (id: string, discordThreadId: string): Promise<void> => {
  const job = await readJob(id);
  if (!job) return;
  job.state = { ...job.state, discordThreadId };
  job.updatedAt = new Date().toISOString();
  await writeJob(job);
};
