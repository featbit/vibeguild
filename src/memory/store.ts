import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  WorldState,
  DailyRecord,
  WorldSignal,
  Escalation,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', 'world');

const paths = {
  worldState: join(ROOT, 'memory', 'world.json'),
  signals: join(ROOT, 'signals.json'),
  runtimeState: join(ROOT, 'sessions', 'runtime.json'),
  daily: (date: string) => join(ROOT, 'memory', 'daily', `${date}.json`),
  escalations: join(ROOT, 'reports', 'escalations.json'),
  taskProgress: (taskId: string) =>
    join(ROOT, 'tasks', taskId, 'progress.json'),
} as const;

const ensureDir = async (filePath: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
};

const readJson = async <T>(filePath: string, fallback: T): Promise<T> => {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const writeJson = async (filePath: string, data: unknown): Promise<void> => {
  await ensureDir(filePath);
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
};

// --- World State ---

export const readWorldState = (): Promise<WorldState> =>
  readJson<WorldState>(paths.worldState, {
    version: 1,
    dayCount: 0,
    startedAt: null,
    lastDayEndedAt: null,
    completedProjects: [],
    keyLearnings: [],
  });

export const writeWorldState = (state: WorldState): Promise<void> =>
  writeJson(paths.worldState, state);

export const incrementDay = async (): Promise<WorldState> => {
  const state = await readWorldState();
  const updated: WorldState = {
    ...state,
    dayCount: state.dayCount + 1,
    lastDayEndedAt: new Date().toISOString(),
  };
  await writeWorldState(updated);
  return updated;
};

export const markWorldStarted = async (): Promise<void> => {
  const state = await readWorldState();
  if (!state.startedAt) {
    await writeWorldState({ ...state, startedAt: new Date().toISOString() });
  }
};

// --- Signals ---

export const readSignals = (): Promise<WorldSignal[]> =>
  readJson<WorldSignal[]>(paths.signals, []);

export const writeSignals = (signals: WorldSignal[]): Promise<void> =>
  writeJson(paths.signals, signals);

export const appendSignal = async (
  type: WorldSignal['type'],
  payload?: unknown,
): Promise<void> => {
  const signals = await readSignals();
  signals.push({
    id: `${type}-${Date.now()}`,
    type,
    payload,
    createdAt: new Date().toISOString(),
    processed: false,
  });
  await writeSignals(signals);
};

export const markSignalProcessed = async (signalId: string): Promise<void> => {
  const signals = await readSignals();
  const updated = signals.map((s) =>
    s.id === signalId ? { ...s, processed: true } : s,
  );
  await writeSignals(updated);
};

export const drainPendingSignals = async (): Promise<WorldSignal[]> => {
  const signals = await readSignals();
  const pending = signals.filter((s) => !s.processed);
  // Mark all pending as processed, then prune: keep only last 100 processed
  const allProcessed = signals.map((s) => ({ ...s, processed: true }));
  const pruned = allProcessed.slice(-100);
  await writeSignals(pruned);
  return pending;
};

// --- Runtime State (frozen / resting — survives status reads) ---

export type RuntimeState = {
  frozen: boolean;
  resting: boolean;
  updatedAt: string;
};

const defaultRuntimeState: RuntimeState = { frozen: false, resting: false, updatedAt: '' };

export const readRuntimeState = (): Promise<RuntimeState> =>
  readJson<RuntimeState>(paths.runtimeState, defaultRuntimeState);

export const writeRuntimeState = (state: Omit<RuntimeState, 'updatedAt'>): Promise<void> =>
  writeJson(paths.runtimeState, { ...state, updatedAt: new Date().toISOString() });

// --- Daily Records ---

export const writeDailyRecord = async (record: DailyRecord): Promise<void> => {
  await writeJson(paths.daily(record.date), record);
};

export const readDailyRecord = (date: string): Promise<DailyRecord | null> =>
  readJson<DailyRecord | null>(paths.daily(date), null);

// --- Task Progress ---

export type TaskCheckpoint = {
  at: string;          // ISO timestamp
  sessionId: string;   // leader's session ID at this point — used for resume
  description: string; // what was accomplished up to here
};

export type TaskProgress = {
  taskId: string;
  status: 'in-progress' | 'completed' | 'failed';
  summary: string;
  percentComplete: number;
  checkpoints: TaskCheckpoint[];
  lastUpdated: string;
};

export const writeTaskProgress = (progress: TaskProgress): Promise<void> =>
  writeJson(paths.taskProgress(progress.taskId), progress);

export const readTaskProgress = (taskId: string): Promise<TaskProgress | null> =>
  readJson<TaskProgress | null>(paths.taskProgress(taskId), null);

// --- Escalations ---

export const appendEscalation = async (escalation: Escalation): Promise<void> => {
  const existing = await readJson<Escalation[]>(paths.escalations, []);
  existing.push(escalation);
  await writeJson(paths.escalations, existing);
};

export const readEscalations = (): Promise<Escalation[]> =>
  readJson<Escalation[]>(paths.escalations, []);

// --- Task Sessions (per-task session for resumption after rest/freeze) ---

const taskSessionPath = (taskId: string) =>
  join(ROOT, 'sessions', 'tasks', `${taskId}.json`);

export const readTaskSession = async (taskId: string): Promise<string | null> => {
  const data = await readJson<{ sessionId: string | null }>(
    taskSessionPath(taskId),
    { sessionId: null },
  );
  return data.sessionId;
};

export const writeTaskSession = (taskId: string, sessionId: string): Promise<void> =>
  writeJson(taskSessionPath(taskId), { sessionId });
