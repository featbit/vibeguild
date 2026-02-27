export type DailyRecord = {
  date: string;
  dayCount: number;
  tasksCompleted: string[];
  tasksInProgress: string[];
  escalationCount: number;
  keyEvents: string[];
  writtenAt: string;
};

export type WorldState = {
  version: number;
  dayCount: number;
  startedAt: string | null;
  lastDayEndedAt: string | null;
  completedProjects: string[];
  keyLearnings: string[];
};

export type WorldSignal = {
  id: string;
  type: 'SHIFT_REST_START' | 'SHIFT_DAY_END' | 'MEETUP_FREEZE' | 'MEETUP_RESUME' | 'TASK_ADDED';
  payload?: unknown;
  createdAt: string;
  processed: boolean;
};

export type Escalation = {
  id: string;
  message: string;
  urgency: 'low' | 'normal' | 'high' | 'critical';
  beingId?: string;
  createdAt: string;
};
