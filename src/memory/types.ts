export type BeingStatus = 'idle' | 'working' | 'resting' | 'frozen' | 'unavailable';

export type BeingProfile = {
  id: string;
  name: string;
  status: BeingStatus;
  skills: string[];
  completedTaskIds: string[];
  currentTaskId?: string;
  currentTeamId?: string;
  lastShiftAt: string | null;
  createdAt: string;
};

export type ShiftSummary = {
  timestamp: string;
  beingId: string;
  dayCount: number;
  tasksWorked: string[];
  keyDecisions: string[];
  whatILearned: string;
  needsFollowUp: string[];
  selfNote?: string;
  source: 'being-initiated' | 'system';
};

export type SelfNote = {
  timestamp: string;
  beingId: string;
  content: unknown;
  source: 'being-initiated';
};

export type DailyRecord = {
  date: string;
  dayCount: number;
  beingsActive: string[];
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

export type TeamRecord = {
  id: string;
  name: string;
  leaderId: string;
  memberIds: string[];
  taskId: string;
  subtaskIds: string[];
  createdAt: string;
  status: 'active' | 'completed' | 'disbanded';
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
