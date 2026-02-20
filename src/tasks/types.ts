export type TaskStatus =
  | 'pending'
  | 'assigned'
  | 'in-progress'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'escalated';

export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

export type TaskCreator = 'human' | 'orchestrator' | 'being';

export type TaskType = 'work' | 'discussion' | 'rest' | 'meetup';

export type Task = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  type: TaskType;
  leaderId?: string;       // being responsible for coordination + progress reports
  assignedTo?: string[];   // all beings on this task (includes leader)
  teamId?: string;
  parentId?: string;
  dependencies: string[];
  requiresPlanApproval: boolean;
  maxBeings?: number;
  priority: TaskPriority;
  createdBy: TaskCreator;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};
