/**
 * Sync helpers — write/read progress and inbox files under world/tasks/{taskId}/.
 *
 * These are the sole I/O touch-points for the synchronisation contract between
 * the execution plane (sandbox) and the world/ creator-facing layer.
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SyncedProgress } from './adapter.js';

const taskDir = (worldRoot: string, taskId: string): string =>
  join(worldRoot, 'tasks', taskId);

// ─── Progress ─────────────────────────────────────────────────────────────────

export const writeProgressSync = async (
  worldRoot: string,
  progress: SyncedProgress,
): Promise<void> => {
  const dir = taskDir(worldRoot, progress.taskId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'progress.json'),
    JSON.stringify(progress, null, 2),
    'utf-8',
  );
};

export const readProgressSync = async (
  worldRoot: string,
  taskId: string,
): Promise<SyncedProgress | null> => {
  try {
    const raw = await readFile(join(taskDir(worldRoot, taskId), 'progress.json'), 'utf-8');
    return JSON.parse(raw) as SyncedProgress;
  } catch {
    return null;
  }
};

// ─── Inbox (human → sandbox) ──────────────────────────────────────────────────

export type InboxFile = {
  messages: string[];
  updatedAt: string;
};

export const writeTaskInbox = async (
  worldRoot: string,
  taskId: string,
  messages: string[],
): Promise<void> => {
  const dir = taskDir(worldRoot, taskId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'inbox.json'),
    JSON.stringify({ messages, updatedAt: new Date().toISOString() } satisfies InboxFile, null, 2),
    'utf-8',
  );
};

/** Read and clear the inbox.  Returns the messages that were pending. */
export const drainTaskInbox = async (
  worldRoot: string,
  taskId: string,
): Promise<string[]> => {
  const p = join(taskDir(worldRoot, taskId), 'inbox.json');
  try {
    const raw = await readFile(p, 'utf-8');
    const data = JSON.parse(raw) as InboxFile;
    await writeFile(
      p,
      JSON.stringify({ messages: [], updatedAt: new Date().toISOString() } satisfies InboxFile, null, 2),
      'utf-8',
    );
    return data.messages ?? [];
  } catch {
    return [];
  }
};
