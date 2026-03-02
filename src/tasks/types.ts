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

export type TaskKind =
  | 'demo'
  | 'dev_insight_blog'
  | 'learning_note'
  | 'issue_feedback'
  | 'skill_validation'
  | 'skill_demo_trigger';

export type TaskCompletionLevel =
  | 'not_started'
  | 'in_progress'
  | 'temp_done'
  | 'fully_done';

export type TeamRole =
  | 'TeamLead'
  | 'Builder'
  | 'Verifier'
  | 'NarrativeEngineer'
  | 'OperatorLiaison';

export const DEFAULT_TEAM_ROLES: TeamRole[] = [
  'TeamLead',
  'Builder',
  'Verifier',
  'NarrativeEngineer',
  'OperatorLiaison',
];

export type Task = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  type: TaskType;
  taskKind: TaskKind;
  completionLevel: TaskCompletionLevel;
  leadRole: TeamRole;
  assignedRoles: TeamRole[];
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
  /** Host-relative workspace metadata pointer (e.g. world/demos/<task>/). */
  sandboxWorkspacePath?: string;
  // ─── Revision tracking ──────────────────────────────────────────────
  /** GitHub repo URL created by the sandbox agent for this task. */
  sandboxRepoUrl?: string;
  /** How many times this task has been re-run via /revise. */
  revisionCount?: number;
  /** The most recent revision feedback from the creator. */
  revisionNote?: string;
  /** Optional operator suggestions captured during execution. */
  suggestions?: string[];
  // ─── Legacy compatibility ─────────────────────────────────────────────
  leaderId?: string;
  assignedTo?: string[];
  /** Legacy thread routing identifier (control-plane compatibility only). */
  discordThreadId?: string;
};
