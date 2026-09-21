/**
 * heartbeat.test.ts — P4: heartbeat counter coarsening (indexstr F14).
 * Exact totals never leave the device; consumers see two-significant-figure
 * classes. Also pins the build → parse roundtrip of the coarsened payload.
 */
import { describe, it, expect } from 'vitest';
import { buildHeartbeat, coarsenCount, parseHeartbeat, HEARTBEAT_KIND } from './heartbeat';

describe('coarsenCount (F14)', () => {
  it('is exact below 100, two significant figures above', () => {
    expect(coarsenCount(0)).toBe(0);
    expect(coarsenCount(42)).toBe(42);
    expect(coarsenCount(99)).toBe(99);
    expect(coarsenCount(100)).toBe(100);
    expect(coarsenCount(123)).toBe(120);
    expect(coarsenCount(999)).toBe(990);
    expect(coarsenCount(12345)).toBe(12000);
    expect(coarsenCount(250_000)).toBe(250_000);
  });

  it('rounds down and never leaks exact totals', () => {
    expect(coarsenCount(101)).toBe(100);
    expect(coarsenCount(199)).toBe(190);
    expect(coarsenCount(10_001)).toBe(10_000);
  });

  it('fails safe on garbage input', () => {
    expect(coarsenCount(-5)).toBe(0);
    expect(coarsenCount(Number.NaN)).toBe(0);
    expect(coarsenCount(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('buildHeartbeat emits coarsened stats', () => {
  it('coarsens pagesIndexed/queueSize/published before signing', async () => {
    const indexerPubkey = 'ab'.repeat(32);
    const event = await buildHeartbeat(
      { pagesIndexed: 12_345, queueSize: 987, published: 55 },
      {
        source: 'indexstr/v2',
        indexerPubkey,
        signer: async (unsigned) => ({ ...unsigned, id: 'x'.repeat(64), pubkey: indexerPubkey, sig: 'y'.repeat(128) }),
        clock: () => 1_800_000_000_000,
      },
    );
    expect(event.kind).toBe(HEARTBEAT_KIND);
    const payload = JSON.parse(event.content) as { stats: Record<string, number> };
    expect(payload.stats).toEqual({ pagesIndexed: 12_000, queueSize: 980, published: 55 });

    // Roundtrip: the coarsened payload parses cleanly.
    const parsed = parseHeartbeat(event);
    expect(parsed?.stats.pagesIndexed).toBe(12_000);
    expect(parsed?.stats.queueSize).toBe(980);
    expect(parsed?.stats.published).toBe(55);
  });
});
