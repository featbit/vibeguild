import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Task, TaskStatus, TaskPriority, TaskType, TaskCreator } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = join(__dirname, '..', '..', 'world', 'tasks', 'queue.json');

const readQueue = async (): Promise<Task[]> => {
  try {
    const raw = await readFile(QUEUE_PATH, 'utf-8');
    return JSON.parse(raw) as Task[];
  } catch {
    return [];
  }
};

const writeQueue = async (tasks: Task[]): Promise<void> => {
  await mkdir(dirname(QUEUE_PATH), { recursive: true });
  await writeFile(QUEUE_PATH, JSON.stringify(tasks, null, 2), 'utf-8');
};

export type EnqueueOptions = {
  title: string;
  description: string;
  priority?: TaskPriority;
  type?: TaskType;
  createdBy?: TaskCreator;
  parentId?: string;
  dependencies?: string[];
  requiresPlanApproval?: boolean;
  maxBeings?: number;
};

export const enqueueTask = async (opts: EnqueueOptions): Promise<Task> => {
  const tasks = await readQueue();
  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    title: opts.title,
    description: opts.description,
    status: 'pending',
    type: opts.type ?? 'work',
    priority: opts.priority ?? 'normal',
    createdBy: opts.createdBy ?? 'human',
    parentId: opts.parentId,
    dependencies: opts.dependencies ?? [],
    requiresPlanApproval: opts.requiresPlanApproval ?? false,
    ...(opts.maxBeings !== undefined ? { maxBeings: opts.maxBeings } : {}),
    createdAt: now,
    updatedAt: now,
  };
  tasks.push(task);
  await writeQueue(tasks);
  return task;
};

export const getPendingTasks = async (): Promise<Task[]> => {
  const tasks = await readQueue();
  return tasks.filter((t) => t.status === 'pending');
};

export const getTasksByStatus = async (status: TaskStatus): Promise<Task[]> => {
  const tasks = await readQueue();
  return tasks.filter((t) => t.status === status);
};

export const updateTaskStatus = async (
  taskId: string,
  status: TaskStatus,
  assignedTo?: string | string[],
): Promise<void> => {
  const tasks = await readQueue();
  const updated = tasks.map((t) => {
    if (t.id !== taskId) return t;
    // Normalize assignedTo: always store as string[] regardless of source format
    const normalizedAssignedTo = assignedTo !== undefined
      ? (Array.isArray(assignedTo) ? assignedTo : [assignedTo])
      : t.assignedTo !== undefined
        ? (Array.isArray(t.assignedTo) ? t.assignedTo : [t.assignedTo as unknown as string])
        : undefined;
    return {
      ...t,
      status,
      ...(normalizedAssignedTo !== undefined ? { assignedTo: normalizedAssignedTo } : {}),
      ...(status === 'completed' ? { completedAt: new Date().toISOString() } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
  await writeQueue(updated);
};

export const getAllTasks = readQueue;

/**
 * Returns the set of beings currently assigned to an active task
 * (status: assigned or in-progress). Used to enforce the rule that
 * a being may only work on one task at a time.
 */
export const getBusyBeings = async (): Promise<string[]> => {
  const tasks = await readQueue();
  const busy = new Set<string>();
  for (const t of tasks) {
    if ((t.status === 'assigned' || t.status === 'in-progress') && Array.isArray(t.assignedTo)) {
      for (const b of t.assignedTo) busy.add(b);
    }
  }
  return [...busy];
};

export const getTaskSummary = async (): Promise<{
  pending: number;
  assigned: number;
  inProgress: number;
  completed: number;
  blocked: number;
}> => {
  const tasks = await readQueue();
  return {
    pending: tasks.filter((t) => t.status === 'pending').length,
    assigned: tasks.filter((t) => t.status === 'assigned').length,
    inProgress: tasks.filter((t) => t.status === 'in-progress').length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
  };
};
