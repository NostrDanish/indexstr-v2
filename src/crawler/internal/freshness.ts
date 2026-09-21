/**
 * Freshness scheduling — how often a URL deserves recrawl.
 *
 * The node maintains an index, not a snapshot: every successfully crawled
 * URL is re-enqueued with a `nextAttempt` at `now + interval`, and the
 * interval adapts to observed change behavior:
 *
 *   - first crawl            → 24h
 *   - recrawl, unchanged     → interval doubles (max 30 days)
 *   - recrawl, changed       → back to 24h
 *
 * Breaking-news pages converge toward daily recrawls; static pages drift
 * toward monthly. The content hash (sha256 of extracted text) is the change
 * detector — cheap, deterministic, and the same signal the network uses.
 *
 * Republishing on recrawl is deliberate: with the same `d`/`x` and a fresh
 * `created_at`, the addressable kind 39697 event says "still alive, same
 * content" — the network's freshness signal.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_INTERVAL = 30 * DAY;

export interface FreshnessState {
  changeCount?: number;
  unchangedStreak?: number;
  lastChangedAt?: number;
}

export interface FreshnessUpdate {
  recrawlDue: number;
  changeCount: number;
  unchangedStreak: number;
  lastChangedAt: number;
}

/**
 * Compute the next freshness state after a successful crawl.
 *
 * @param existing  previous freshness state (undefined = first crawl)
 * @param changed   whether the content hash differs from last time
 * @param now       unix ms
 */
export function nextFreshness(
  existing: FreshnessState | undefined,
  changed: boolean,
  now: number,
): FreshnessUpdate {
  const prevStreak = existing?.unchangedStreak ?? 0;
  const prevChanges = existing?.changeCount ?? 0;

  if (changed) {
    return {
      recrawlDue: now + DAY,
      changeCount: prevChanges + 1,
      unchangedStreak: 0,
      lastChangedAt: now,
    };
  }

  const streak = prevStreak + 1;
  const interval = Math.min(MAX_INTERVAL, DAY * 2 ** streak);
  return {
    recrawlDue: now + interval,
    changeCount: prevChanges,
    unchangedStreak: streak,
    lastChangedAt: existing?.lastChangedAt ?? now,
  };
}
