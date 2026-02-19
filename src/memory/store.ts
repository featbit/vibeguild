import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  WorldState,
  DailyRecord,
  ShiftSummary,
  BeingProfile,
  TeamRecord,
  WorldSignal,
  Escalation,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', 'world');

const paths = {
  worldState: join(ROOT, 'memory', 'world.json'),
  signals: join(ROOT, 'signals.json'),
  daily: (date: string) => join(ROOT, 'memory', 'daily', `${date}.json`),
  team: (teamId: string) => join(ROOT, 'memory', 'team', `${teamId}.json`),
  shiftSummary: (beingId: string, timestamp: string) =>
    join(ROOT, 'beings', beingId, 'memory', 'shifts', `${timestamp}.json`),
  beingProfile: (beingId: string) =>
    join(ROOT, 'beings', beingId, 'profile.json'),
  escalations: join(ROOT, 'reports', 'escalations.json'),
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
  const allProcessed = signals.map((s) => ({ ...s, processed: true }));
  await writeSignals(allProcessed);
  return pending;
};

// --- Daily Records ---

export const writeDailyRecord = async (record: DailyRecord): Promise<void> => {
  await writeJson(paths.daily(record.date), record);
};

export const readDailyRecord = (date: string): Promise<DailyRecord | null> =>
  readJson<DailyRecord | null>(paths.daily(date), null);

// --- Being Profiles ---

export const readBeingProfile = (beingId: string): Promise<BeingProfile | null> =>
  readJson<BeingProfile | null>(paths.beingProfile(beingId), null);

export const writeBeingProfile = (
  beingId: string,
  profile: BeingProfile,
): Promise<void> => writeJson(paths.beingProfile(beingId), profile);

export const updateBeingStatus = async (
  beingId: string,
  status: BeingProfile['status'],
  currentTaskId?: string,
): Promise<void> => {
  const profile = await readBeingProfile(beingId);
  if (!profile) return;
  await writeBeingProfile(beingId, {
    ...profile,
    status,
    currentTaskId,
    lastShiftAt: new Date().toISOString(),
  });
};

// --- Shift Summaries ---

export const writeShiftSummary = (summary: ShiftSummary): Promise<void> =>
  writeJson(paths.shiftSummary(summary.beingId, summary.timestamp), summary);

// --- Team Records ---

export const readTeamRecord = (teamId: string): Promise<TeamRecord | null> =>
  readJson<TeamRecord | null>(paths.team(teamId), null);

export const writeTeamRecord = (
  teamId: string,
  record: TeamRecord,
): Promise<void> => writeJson(paths.team(teamId), record);

// --- Escalations ---

export const appendEscalation = async (escalation: Escalation): Promise<void> => {
  const existing = await readJson<Escalation[]>(paths.escalations, []);
  existing.push(escalation);
  await writeJson(paths.escalations, existing);
};

export const readEscalations = (): Promise<Escalation[]> =>
  readJson<Escalation[]>(paths.escalations, []);

// --- Session ID ---

const sessionPath = join(ROOT, 'sessions', 'orchestrator.json');

export const readSessionId = async (): Promise<string | null> => {
  const data = await readJson<{ sessionId: string | null }>(sessionPath, {
    sessionId: null,
  });
  return data.sessionId;
};

export const writeSessionId = (sessionId: string): Promise<void> =>
  writeJson(sessionPath, { sessionId });
