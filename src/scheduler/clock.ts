import { appendSignal } from '../memory/store.js';

// MVP day cadence: 10 real minutes = 1 world day
// 8 minutes work → 2 minutes rest → new day
const WORK_DURATION_MS = 8 * 60 * 1000;
const DAY_DURATION_MS = 10 * 60 * 1000;
export const REST_DURATION_MS = DAY_DURATION_MS - WORK_DURATION_MS;

let restTimer: ReturnType<typeof setTimeout> | null = null;
let dayTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

const onRestStart = async (): Promise<void> => {
  console.log(`\n⏸  [CLOCK] Rest period started — writing shift rest signal.`);
  await appendSignal('SHIFT_REST_START', { restDurationMs: REST_DURATION_MS });
  // Runners are NOT interrupted. The soft signal is delivered via injectMessage
  // in the next scheduler tick. Runners continue until they choose a checkpoint.
};

const onDayEnd = async (startNextCycle: () => void): Promise<void> => {
  console.log(`\n🌅 [CLOCK] Day ended — writing day-end signal.`);
  await appendSignal('SHIFT_DAY_END');
  // Runners keep running. The engine writes daily record from observable state.
  if (running) {
    startNextCycle();
  }
};

const startCycle = (): void => {
  const cycleStartedAt = new Date().toISOString();
  console.log(`\n🌄 [CLOCK] New day started at ${cycleStartedAt} (${WORK_DURATION_MS / 60000} min work → ${REST_DURATION_MS / 60000} min rest)`);

  restTimer = setTimeout(() => {
    void onRestStart();
  }, WORK_DURATION_MS);

  dayTimer = setTimeout(() => {
    void onDayEnd(startCycle);
  }, DAY_DURATION_MS);
};

export const startClock = (): void => {
  if (running) return;
  running = true;
  startCycle();
};

export const stopClock = (): void => {
  running = false;
  if (restTimer) {
    clearTimeout(restTimer);
    restTimer = null;
  }
  if (dayTimer) {
    clearTimeout(dayTimer);
    dayTimer = null;
  }
};

export const triggerMeetupFreeze = async (): Promise<void> => {
  console.log(`\n❄️  [CLOCK] Meetup freeze triggered — all beings will suspend work.`);
  await appendSignal('MEETUP_FREEZE');
};

export const triggerMeetupResume = async (): Promise<void> => {
  console.log(`\n▶️  [CLOCK] Meetup resume triggered — beings returning to work.`);
  await appendSignal('MEETUP_RESUME');
};
