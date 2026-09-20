/**
 * backoff.ts — bounded exponential backoff with jitter for transient
 * fetch failures (blueprint §4: "retry ≤3 with backoff; jobs don't spin").
 *
 * Schedule (before jitter): attempt 1 → 30 s, 2 → 2 m, 3 → 8 m, then the
 * 10-minute cap binds. Jitter is ±25% (full jitter would cluster retries
 * near zero; a bounded band keeps politeness while decorrelating nodes
 * that fail at the same moment — thundering-herd protection).
 *
 * The delay is stored on the job's `nextAttempt`; the queue's nextJob
 * cursor skips future-dated jobs, so a backed-off job never spins the
 * crawl loop.
 */

/** First retry delay: 30 seconds. */
export const BACKOFF_BASE_MS = 30_000;
/** Hard ceiling: 10 minutes, no matter how many attempts. */
export const BACKOFF_CAP_MS = 10 * 60_000;
/** Growth factor per attempt (30 s → 2 m → 8 m). */
export const BACKOFF_FACTOR = 4;
/** Jitter band: ±25% around the exponential value. */
export const BACKOFF_JITTER = 0.25;

/**
 * Delay before retry `attempt` (1-based: the first retry is attempt 1).
 * `rand` is a [0,1) entropy source — injectable for deterministic tests,
 * defaults to Math.random().
 */
export function retryBackoffMs(attempt: number, rand: number = Math.random()): number {
  const exponential = BACKOFF_BASE_MS * BACKOFF_FACTOR ** Math.max(0, attempt - 1);
  const bounded = Math.min(BACKOFF_CAP_MS, exponential);
  const jitter = 1 - BACKOFF_JITTER + rand * BACKOFF_JITTER * 2; // [0.75, 1.25)
  return Math.round(bounded * jitter);
}
