/**
 * backoff.test.ts — the transient-retry schedule: bounded exponential
 * growth, hard cap, ±25% jitter, and no spinning (a backed-off job is
 * always scheduled strictly in the future).
 */
import { describe, expect, it } from 'vitest';

import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BACKOFF_FACTOR,
  BACKOFF_JITTER,
  retryBackoffMs,
} from './backoff';

describe('retryBackoffMs — bounded exponential backoff with jitter', () => {
  it('follows the 30s → 2m → 8m schedule at the jitter midpoint', () => {
    expect(retryBackoffMs(1, 0.5)).toBe(30_000);
    expect(retryBackoffMs(2, 0.5)).toBe(120_000);
    expect(retryBackoffMs(3, 0.5)).toBe(480_000);
  });

  it('is bounded by the 10-minute cap no matter how large the attempt', () => {
    expect(retryBackoffMs(4, 0.5)).toBe(BACKOFF_CAP_MS);
    expect(retryBackoffMs(10, 0.5)).toBe(BACKOFF_CAP_MS);
    expect(retryBackoffMs(100, 1)).toBeLessThanOrEqual(BACKOFF_CAP_MS * (1 + BACKOFF_JITTER));
  });

  it('jitter stays inside the ±25% band at the entropy extremes', () => {
    for (const attempt of [1, 2, 3, 8]) {
      const base = Math.min(
        BACKOFF_CAP_MS,
        BACKOFF_BASE_MS * BACKOFF_FACTOR ** (attempt - 1),
      );
      expect(retryBackoffMs(attempt, 0)).toBe(Math.round(base * (1 - BACKOFF_JITTER)));
      // rand ∈ [0,1): the top of the band is never meaningfully exceeded
      // (integer rounding may land exactly on it).
      expect(retryBackoffMs(attempt, 0.999999)).toBeLessThanOrEqual(
        Math.round(base * (1 + BACKOFF_JITTER)),
      );
    }
  });

  it('grows monotonically (at midpoint) until the cap', () => {
    const delays = [1, 2, 3, 4, 5].map((a) => retryBackoffMs(a, 0.5));
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
  });

  it('jobs never spin: even the lowest-jitter first retry is ≥22.5s out', () => {
    expect(retryBackoffMs(1, 0)).toBeGreaterThanOrEqual(22_500);
    expect(retryBackoffMs(1, 0)).toBeLessThanOrEqual(37_500);
  });

  it('attempt 0 / garbage attempts clamp to the first step', () => {
    expect(retryBackoffMs(0, 0.5)).toBe(BACKOFF_BASE_MS);
    expect(retryBackoffMs(-3, 0.5)).toBe(BACKOFF_BASE_MS);
  });
});
