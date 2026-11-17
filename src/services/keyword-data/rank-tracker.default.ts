/**
 * The live rank tracker, and its scheduler.
 *
 * Follows trial-emails.service.ts: a setInterval loop started from index.ts.
 *
 * OFF BY DEFAULT. The tracker is driven by hand from the admin panel: "Check now" on a row, or
 * "Check all" in the toolbar. The scheduler is kept, because unattended checking is the only way
 * to get a rank history with no holes in it — a week nobody presses the button is a week of data
 * that cannot be recovered afterwards — but it does not run unless someone turns it on.
 *
 *   RANK_TRACKER_ENABLED     Opt-in. "true", "1", "on" or "yes" starts the scheduler. Unset or
 *                            anything else leaves it off; the panel's buttons work either way.
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

/**
 * Whether the scheduler should run. Opt-in: nothing happens unless it is switched on explicitly.
 *
 * Exported so the rule is testable without starting a timer — the thing that decides whether a
 * deploy spends money unattended should not be reachable only through a side effect.
 */
export function rankTrackerSchedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RANK_TRACKER_ENABLED ?? '').trim().toLowerCase();
  return ['true', '1', 'on', 'yes'].includes(raw);
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
  if (!rankTrackerSchedulerEnabled()) {
    console.log('ℹ️  Rank tracker scheduler off (set RANK_TRACKER_ENABLED=true to run it). Checks from the admin panel still work.');
    return;
  }
  if (!isKeywordFinderConfigured()) {
    console.warn('⚠️  Rank tracker scheduler not started: DataForSEO credentials are missing.');
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
