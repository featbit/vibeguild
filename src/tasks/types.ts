export type TaskStatus =
  | 'pending'
  | 'assigned'
  | 'in-progress'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'escalated';

export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

export type TaskCreator = 'human' | 'orchestrator' | 'cron';

export type TaskType = 'work' | 'meetup';

export type Task = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  type: TaskType;
  parentId?: string;
  dependencies: string[];
  requiresPlanApproval: boolean;
  priority: TaskPriority;
  createdBy: TaskCreator;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  // ─── Sandbox execution plane ───────────────────────────────────────────
  /** Docker container ID while the task is running in sandbox mode. */
  sandboxContainerId?: string;
  /** GitHub repo URL for this task's execution artifacts (docker mode). */
  sandboxRepoUrl?: string;
  // ─── Revision tracking ──────────────────────────────────────────────
  /** How many times this task has been re-run via /revise. */
  revisionCount?: number;
  /** The most recent revision feedback from the creator. */
  revisionNote?: string;
  /**
   * If set, the task's progress messages are routed to this existing Discord
   * thread (e.g. a cron-job thread) instead of creating a new tasks-forum post.
   */
  discordThreadId?: string;
};
