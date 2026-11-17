/**
 * The live rank tracker, and its scheduler.
 *
 * Follows trial-emails.service.ts: a setInterval loop started from index.ts, off unless its env
 * flag says otherwise. Rank checks cost money on every tick, so the default is OFF and both the
 * cadence and the per-tick ceiling are explicit.
 *
 *   RANK_TRACKER_ENABLED     "true" starts the scheduler. Anything else leaves it off, and the
 *                            admin panel's Check and Run buttons still work on demand.
 *   RANK_TRACKER_STALE_HOURS How old a check must be before it is redone. Default 168 (weekly):
 *                            positions do not move fast enough to be worth paying for daily.
 *   RANK_TRACKER_MAX_PER_RUN Hard ceiling on SERP calls per tick. Default 50, so a tick can never
 *                            cost more than about 18 cents however many targets accumulate.
 */
import { createRankTracker } from './rank-tracker.service.js';
import { createSerpSignalService } from './serp-signal.service.js';
import { getSerpClient, isKeywordFinderConfigured } from './keyword-finder.default.js';

let singleton: ReturnType<typeof createRankTracker> | null = null;

export function getRankTracker() {
  if (singleton) return singleton;
  singleton = createRankTracker({ serp: createSerpSignalService({ client: getSerpClient() }) });
  return singleton;
}

export function __resetRankTracker(): void {
  singleton = null;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const n = parseInt(raw, 10);
  return n > 0 ? n : fallback;
}

/** One hour between ticks; the staleness rule, not the tick rate, decides what actually runs. */
const INTERVAL_MS = 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

export function startRankTrackerScheduler(): void {
  if (timer) return;
  if ((process.env.RANK_TRACKER_ENABLED ?? '').trim() !== 'true') {
    console.log('ℹ️  Rank tracker scheduler off (RANK_TRACKER_ENABLED is not "true"). On-demand checks still work.');
    return;
  }
  if (!isKeywordFinderConfigured()) {
    console.warn('⚠️  RANK_TRACKER_ENABLED is true but DataForSEO credentials are missing; scheduler not started.');
    return;
  }

  const staleHours = intFromEnv('RANK_TRACKER_STALE_HOURS', 24 * 7);
  const max = intFromEnv('RANK_TRACKER_MAX_PER_RUN', 50);

  const run = async () => {
    try {
      await getRankTracker().runDue({ staleHours, max });
    } catch (err) {
      // Never let a failed tick kill the interval; the same targets are due again next hour.
      console.error('[rank-tracker] scheduled run failed:', err);
    }
  };

  timer = setInterval(run, INTERVAL_MS);
  // Do not hold the process open for a scheduled rank check during shutdown.
  timer.unref?.();
  void run();
  console.log(`📈 Rank tracker scheduler started (hourly tick, recheck after ${staleHours}h, max ${max} per run).`);
}

export function stopRankTrackerScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
