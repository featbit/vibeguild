import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TEAM_ROLES,
  type Task,
  type TaskStatus,
  type TaskPriority,
  type TaskType,
  type TaskCreator,
  type TaskKind,
  type TaskCompletionLevel,
  type TeamRole,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = join(__dirname, '..', '..', 'world', 'tasks', 'queue.json');

const DEFAULT_LEAD_ROLE: TeamRole = 'TeamLead';

const inferTaskKind = (title: string, description: string): TaskKind => {
  const text = `${title}\n${description}`.toLowerCase();
  if (/\b(demo|showcase|walkthrough|playground|sample app)\b/.test(text)) return 'demo';
  if (/\b(blog|insight|article|post|newsletter)\b/.test(text)) return 'dev_insight_blog';
  if (/\b(learn|learning|note|study|summary|research)\b/.test(text)) return 'learning_note';
  if (/\b(issue|bug|feedback|fix|complaint|report)\b/.test(text)) return 'issue_feedback';
  if (/\b(validate|verification|verify|qa|test skill)\b/.test(text)) return 'skill_validation';
  if (/\b(trigger|from skill|skill to demo|skill-demo)\b/.test(text)) return 'skill_demo_trigger';
  return 'skill_demo_trigger';
};

const statusToCompletionLevel = (status: TaskStatus): TaskCompletionLevel => {
  if (status === 'pending' || status === 'assigned') return 'not_started';
  if (status === 'completed') return 'fully_done';
  if (status === 'failed') return 'temp_done';
  return 'in_progress';
};

const normalizeRoles = (roles: unknown): TeamRole[] => {
  if (!Array.isArray(roles)) return [...DEFAULT_TEAM_ROLES];
  const allowed = new Set<TeamRole>(DEFAULT_TEAM_ROLES);
  const picked = roles
    .filter((r): r is TeamRole => typeof r === 'string' && allowed.has(r as TeamRole));
  return picked.length > 0 ? picked : [...DEFAULT_TEAM_ROLES];
};

const normalizeTask = (raw: Partial<Task>): Task => {
  const now = new Date().toISOString();
  const status = raw.status ?? 'pending';
  const title = raw.title ?? '(untitled task)';
  const description = raw.description ?? title;
  const assignedRoles = normalizeRoles(raw.assignedRoles);
  const leadRole = assignedRoles.includes(raw.leadRole ?? DEFAULT_LEAD_ROLE)
    ? (raw.leadRole ?? DEFAULT_LEAD_ROLE)
    : DEFAULT_LEAD_ROLE;

  return {
    id: raw.id ?? randomUUID(),
    title,
    description,
    status,
    type: raw.type ?? 'work',
    taskKind: raw.taskKind ?? inferTaskKind(title, description),
    completionLevel: raw.completionLevel ?? statusToCompletionLevel(status),
    leadRole,
    assignedRoles,
    parentId: raw.parentId,
    dependencies: Array.isArray(raw.dependencies) ? raw.dependencies : [],
    requiresPlanApproval: raw.requiresPlanApproval ?? false,
    priority: raw.priority ?? 'normal',
    createdBy: raw.createdBy ?? 'human',
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now,
    completedAt: raw.completedAt,
    sandboxContainerId: raw.sandboxContainerId,
    sandboxWorkspacePath: raw.sandboxWorkspacePath,
    revisionCount: raw.revisionCount,
    revisionNote: raw.revisionNote,
    suggestions: Array.isArray(raw.suggestions) ? raw.suggestions : undefined,
    leaderId: raw.leaderId,
    assignedTo: Array.isArray(raw.assignedTo) ? raw.assignedTo : undefined,
    discordThreadId: raw.discordThreadId,
  };
};

const readQueue = async (): Promise<Task[]> => {
  try {
    const raw = await readFile(QUEUE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Array<Partial<Task>>;
    return parsed.map(normalizeTask);
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
  taskKind?: TaskKind;
  completionLevel?: TaskCompletionLevel;
  leadRole?: TeamRole;
  assignedRoles?: TeamRole[];
  createdBy?: TaskCreator;
  parentId?: string;
  dependencies?: string[];
  requiresPlanApproval?: boolean;
  discordThreadId?: string;
};

export const enqueueTask = async (opts: EnqueueOptions): Promise<Task> => {
  const tasks = await readQueue();
  const now = new Date().toISOString();
  const taskKind = opts.taskKind ?? inferTaskKind(opts.title, opts.description);
  const assignedRoles = normalizeRoles(opts.assignedRoles);
  const leadRole = assignedRoles.includes(opts.leadRole ?? DEFAULT_LEAD_ROLE)
    ? (opts.leadRole ?? DEFAULT_LEAD_ROLE)
    : DEFAULT_LEAD_ROLE;
  const task: Task = {
    id: randomUUID(),
    title: opts.title,
    description: opts.description,
    status: 'pending',
    type: opts.type ?? 'work',
    taskKind,
    completionLevel: opts.completionLevel ?? 'not_started',
    leadRole,
    assignedRoles,
    priority: opts.priority ?? 'normal',
    createdBy: opts.createdBy ?? 'human',
    parentId: opts.parentId,
    dependencies: opts.dependencies ?? [],
    requiresPlanApproval: opts.requiresPlanApproval ?? false,
    createdAt: now,
    updatedAt: now,
    ...(opts.discordThreadId ? { discordThreadId: opts.discordThreadId } : {}),
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
): Promise<void> => {
  const tasks = await readQueue();
  const updated = tasks.map((t) => {
    if (t.id !== taskId) return t;
    return {
      ...t,
      status,
      completionLevel: statusToCompletionLevel(status),
      ...(status === 'completed' ? { completedAt: new Date().toISOString() } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
  await writeQueue(updated);
};

export const setTaskCompletionLevel = async (
  taskId: string,
  completionLevel: TaskCompletionLevel,
): Promise<void> => {
  const tasks = await readQueue();
  const updated = tasks.map((t) =>
    t.id !== taskId
      ? t
      : {
          ...t,
          completionLevel,
          updatedAt: new Date().toISOString(),
        },
  );
  await writeQueue(updated);
};

export const getAllTasks = readQueue;

/**
 * Reset a completed or failed task for revision.
 * Clears the old container ID, increments revision counter,
 * stores the creator's feedback, and resets status to 'in-progress'
 * so the scheduler will spin up a new sandbox.
 */
export const reviseTask = async (
  taskId: string,
  feedback: string,
): Promise<Task | null> => {
  const tasks = await readQueue();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return null;
  const now = new Date().toISOString();
  const revised: Task = {
    ...task,
    status: 'in-progress',
    completionLevel: 'in_progress',
    revisionCount: (task.revisionCount ?? 0) + 1,
    revisionNote: feedback,
    sandboxContainerId: undefined,
    completedAt: undefined,
    updatedAt: now,
  };
  await writeQueue(tasks.map((t) => (t.id === taskId ? revised : t)));
  return revised;
};

/**
 * Record sandbox metadata (containerId, workspacePath) on the task after the
 * Docker adapter starts.  Idempotent — safe to call multiple times.
 */
export const updateTaskSandbox = async (
  taskId: string,
  sandbox: { containerId?: string; workspacePath?: string },
): Promise<void> => {
  const tasks = await readQueue();
  const updated = tasks.map((t) =>
    t.id !== taskId
      ? t
      : {
          ...t,
          ...(sandbox.containerId ? { sandboxContainerId: sandbox.containerId } : {}),
          ...(sandbox.workspacePath ? { sandboxWorkspacePath: sandbox.workspacePath } : {}),
          updatedAt: new Date().toISOString(),
        },
  );
  await writeQueue(updated);
};

export const getTaskSummary = async (): Promise<{
  pending: number;
  assigned: number;
  inProgress: number;
  completed: number;
  blocked: number;
  tempDone: number;
  fullyDone: number;
}> => {
  const tasks = await readQueue();
  return {
    pending: tasks.filter((t) => t.status === 'pending').length,
    assigned: tasks.filter((t) => t.status === 'assigned').length,
    inProgress: tasks.filter((t) => t.status === 'in-progress').length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
    tempDone: tasks.filter((t) => t.completionLevel === 'temp_done').length,
    fullyDone: tasks.filter((t) => t.completionLevel === 'fully_done').length,
  };
};
