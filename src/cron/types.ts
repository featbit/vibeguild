/**
 * Cron job types.
 *
 * Each job lives in its own folder: world/crons/{id}/job.json
 *
 * Schedule kinds:
 *   - "at"    → one-shot ISO 8601 timestamp
 *   - "every" → recurring fixed interval (milliseconds)
 *   - "cron"  → standard 5-field cron expression (uses node-cron)
 *
 * Runtime choices (set per job):
 *   - "local"  → runs inline in the scheduler process; no container spawned.
 *                Ideal for lightweight/frequent actions (notifications, pings).
 *   - "docker" → enqueues a full AI Task into the world queue; runs in a
 *                Docker container (or local process when RUNTIME_MODE=local).
 *                Ideal for AI-powered or long-running work.
 */

import type { TaskPriority } from '../tasks/types.js';

// ─── Schedule ─────────────────────────────────────────────────────────────────

export type CronScheduleAt = {
  kind: 'at';
  /** ISO 8601 datetime string (treated as UTC when no TZ offset given). */
  at: string;
};

export type CronScheduleEvery = {
  kind: 'every';
  /** Interval in milliseconds. */
  everyMs: number;
  /** Epoch ms anchor for alignment (defaults to job creation time). */
  anchorMs?: number;
};

export type CronScheduleCron = {
  kind: 'cron';
  /** 5-field cron expression, e.g. "0 9 * * 1" = every Monday at 09:00. */
  expr: string;
  /** IANA timezone, e.g. "Asia/Shanghai". Defaults to system local TZ. */
  tz?: string;
};

export type CronSchedule = CronScheduleAt | CronScheduleEvery | CronScheduleCron;

// ─── Payload ──────────────────────────────────────────────────────────────────

/**
 * Local payload — script executed inline, no container.
 * The actual program lives in world/crons/{id}/run.mjs (Node.js ESM).
 * stdout from that script is posted to the job's Discord forum thread.
 * description is a human-readable hint used by the bot when writing/updating run.mjs.
 */
export type CronPayloadLocal = {
  /** What this job should do — used by the bot to write or update run.mjs. */
  description: string;
};

/**
 * Docker payload — spawns a full AI Task via enqueueTask().
 * Runs in a Docker container when RUNTIME_MODE=docker.
 */
export type CronPayloadDocker = {
  title: string;
  description: string;
  priority?: TaskPriority;
};

// ─── State ────────────────────────────────────────────────────────────────────

export type CronJobState = {
  /** Epoch ms of the next scheduled run (used by "at" and "every" jobs). */
  nextRunAtMs?: number;
  /** Epoch ms of the most recent run. */
  lastRunAtMs?: number;
  /** Task ID of the most recently spawned task (docker runtime only). */
  lastTaskId?: string;
  /** Whether the last run succeeded or resulted in an error. */
  lastStatus?: 'ok' | 'error';
  /** Total number of times this job has fired. */
  runCount?: number;
  /** Discord thread/post ID in the cron jobs forum channel. */
  discordThreadId?: string;
};

// ─── CronJob ──────────────────────────────────────────────────────────────────

export type CronJob = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  /**
   * Where to run this job when it fires.
   *
   * - "local"  → inline in the scheduler (no task, no container)
   * - "docker" → enqueue a Task (runs in Docker / local adapter)
   */
  runtime: 'local' | 'docker';
  /**
   * For "at" schedules: delete the job folder after it fires successfully.
   * Defaults to true for one-shot jobs.
   */
  deleteAfterRun?: boolean;
  schedule: CronSchedule;
  /** Payload shape depends on runtime: CronPayloadLocal or CronPayloadDocker. */
  payload: CronPayloadLocal | CronPayloadDocker;
  state: CronJobState;
  createdAt: string;
  updatedAt: string;
};

/** Input type when creating a new cron job (id, timestamps, state are auto-generated). */
export type CronJobCreate = Omit<CronJob, 'id' | 'createdAt' | 'updatedAt' | 'state'>;

/** Partial fields for updating an existing cron job. */
export type CronJobPatch = Partial<Omit<CronJob, 'id' | 'createdAt' | 'state'>>;
