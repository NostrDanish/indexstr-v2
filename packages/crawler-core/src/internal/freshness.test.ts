import { describe, expect, test } from 'vitest';
import { nextFreshness } from './freshness';

const DAY = 24 * 3_600_000;
const MAX_INTERVAL_DAYS = 30 * DAY;
const NOW = 1_800_000_000_000;

describe('nextFreshness', () => {
  test('first crawl schedules 24h out', () => {
    const f = nextFreshness(undefined, true, NOW);
    expect(f.recrawlDue).toBe(NOW + DAY);
    expect(f.changeCount).toBe(1);
    expect(f.unchangedStreak).toBe(0);
    expect(f.lastChangedAt).toBe(NOW);
  });

  test('unchanged recrawls back off exponentially, capped at 30 days', () => {
    let state = nextFreshness(undefined, true, NOW);
    state = nextFreshness(state, false, NOW + DAY);
    expect(state.recrawlDue).toBe(NOW + DAY + 2 * DAY);
    expect(state.unchangedStreak).toBe(1);

    state = nextFreshness(state, false, state.recrawlDue);
    expect(state.unchangedStreak).toBe(2);

    // Walk to the cap — assert the PER-STEP interval never exceeds 30 days
    // (the v1 test asserted the cumulative sum, which is arithmetically
    // impossible; the intended invariant is per-interval).
    for (let i = 0; i < 10; i++) {
      const before = state.recrawlDue;
      state = nextFreshness(state, false, state.recrawlDue);
      expect(state.recrawlDue - before).toBeLessThanOrEqual(MAX_INTERVAL_DAYS);
    }
  });

  test('a change resets the backoff', () => {
    let state = nextFreshness(undefined, true, NOW);
    state = nextFreshness(state, false, NOW + DAY);
    state = nextFreshness(state, false, state.recrawlDue);
    expect(state.unchangedStreak).toBe(2);

    const changedAt = state.recrawlDue;
    state = nextFreshness(state, true, changedAt);
    expect(state.unchangedStreak).toBe(0);
    expect(state.changeCount).toBe(2);
    expect(state.recrawlDue).toBe(changedAt + DAY);
    expect(state.lastChangedAt).toBe(changedAt);
  });

  test('lastChangedAt is sticky across unchanged recrawls', () => {
    let state = nextFreshness(undefined, true, NOW);
    state = nextFreshness(state, false, NOW + DAY);
    state = nextFreshness(state, false, state.recrawlDue);
    expect(state.lastChangedAt).toBe(NOW);
  });
});
