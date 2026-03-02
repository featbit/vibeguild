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

export type TeamRole =
  | 'TeamLead'
  | 'Builder'
  | 'Verifier'
  | 'NarrativeEngineer'
  | 'OperatorLiaison';

export type TeamManifest = {
  teamId: string;
  name: string;
  leadRole: TeamRole;
  roles: TeamRole[];
  roleAgents: Record<TeamRole, string>;
  initializedAt: string;
  updatedAt: string;
};

export type AlignmentActor = 'agent' | 'operator' | 'system';

export type AlignmentEventKind = 'pause_request' | 'question' | 'reply' | 'resume' | 'status';

export type AlignmentEvent = {
  taskId: string;
  at: string;
  actor: AlignmentActor;
  kind: AlignmentEventKind;
  message: string;
};
