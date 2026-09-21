/** meter.test.ts — port of crawlstr meter.test.ts (class instance). */
import { describe, it, expect } from 'vitest';
import { Meter } from './meter';

describe('meter — sliding-window resource accounting', () => {
  it('counts bytes within the hour window', () => {
    const m = new Meter();
    m.recordFetch(1000);
    m.recordFetch(2000);
    expect(m.bytesLastHour()).toBe(3000);
  });

  it('expires entries older than one hour', () => {
    const m = new Meter();
    const now = Date.now();
    const old = now - 61 * 60 * 1000; // 61 min ago
    m.recordFetch(5000, old);
    m.recordFetch(1000, now);
    expect(m.bytesLastHour(now)).toBe(1000);
  });

  it('counts pages separately from bytes', () => {
    const m = new Meter();
    m.recordFetch(10000);
    m.recordPage();
    m.recordPage();
    expect(m.pagesLastHour()).toBe(2);
  });

  it('pages window also expires', () => {
    const m = new Meter();
    const now = Date.now();
    const old = now - 61 * 60 * 1000;
    m.recordPage(old);
    m.recordPage(now);
    expect(m.pagesLastHour(now)).toBe(1);
  });

  it('remainingBytesThisHour never goes negative', () => {
    const m = new Meter();
    m.recordFetch(10000);
    expect(m.remainingBytesThisHour(5000)).toBe(0);
    expect(m.remainingBytesThisHour(20000)).toBe(10000);
  });

  it('tracks session totals independently of the window', () => {
    const m = new Meter();
    m.recordFetch(1000);
    m.recordFetch(2000);
    const { bytes, fetches } = m.getSessionTotals();
    expect(bytes).toBe(3000);
    expect(fetches).toBe(2);
  });
});

describe('pages/hour sliding window (ported from indexstr limits.test.ts)', () => {
  it('not exceeded below the limit', () => {
    const m = new Meter();
    const now = Date.now();
    for (let i = 0; i < 99; i++) m.recordFetchAttempt(now - i * 1000);
    expect(m.pagesPerHourExceeded(100, now)).toBe(false);
  });

  it('exceeded at the limit', () => {
    const m = new Meter();
    const now = Date.now();
    for (let i = 0; i < 100; i++) m.recordFetchAttempt(now - i * 1000);
    expect(m.pagesPerHourExceeded(100, now)).toBe(true);
  });

  it('old attempts fall out of the window', () => {
    const m = new Meter();
    const now = Date.now();
    // 100 attempts two hours ago — should NOT count.
    for (let i = 0; i < 100; i++) m.recordFetchAttempt(now - 2 * 3_600_000 - i * 1000);
    m.recordFetchAttempt(now);
    expect(m.pagesPerHourExceeded(100, now)).toBe(false);
  });

  it('limit 0 means unlimited', () => {
    const m = new Meter();
    const now = Date.now();
    for (let i = 0; i < 5000; i++) m.recordFetchAttempt(now - i * 100);
    expect(m.pagesPerHourExceeded(0, now)).toBe(false);
  });
});

describe('reserve-on-dispatch (P3 spike finding #7 — budget = hard ceiling)', () => {
  /**
   * The dispatch pattern the engine's slot runners use — wait-check and
   * reservation as ONE synchronous step, mirroring engine.dispatchOnce().
   * Returns the wait time when blocked (no reservation taken).
   */
  const dispatch = (m: Meter, pagesPerHour: number, bytesPerHour: number, pageBytes: number, now: number): number => {
    const wait = Math.max(
      m.pagesBudgetWaitMs(pagesPerHour, now),
      m.bytesBudgetWaitMs(bytesPerHour, 16 * 1024, now),
    );
    if (wait > 0) return wait;
    m.recordFetchAttempt(now);
    const grant =
      bytesPerHour > 0
        ? Math.min(pageBytes, bytesPerHour - m.bytesLastHour(now) - m.getReservedBytes())
        : pageBytes;
    return -m.reserveBytes(grant).bytes;
  };

  it('pages/hour window NEVER exceeds the limit with 8 slots reserving in the same tick', () => {
    let now = 1_000_000_000;
    const m = new Meter(() => now);
    const limit = 500;
    // Simulate 8 slots dispatching in lockstep bursts (worst case: every
    // slot observes headroom in the same synchronous tick).
    for (let burst = 0; burst < 200; burst++) {
      for (let slot = 0; slot < 8; slot++) {
        const wait = dispatch(m, limit, 0, 100_000, now);
        expect(wait).not.toBe(0); // only waits or reservations
        if (wait > 0) break; // blocked slots wait — no reservation taken
      }
      // THE CEILING PROOF: after every burst the window holds ≤ limit.
      expect(m.attemptsLastHour(now)).toBeLessThanOrEqual(limit);
      now += 10_000; // 8 pages / 10 s ≈ 2880/h attempted — far over budget
    }
    expect(m.attemptsLastHour(now)).toBeLessThanOrEqual(limit);
  });

  it('pagesBudgetWaitMs points at the oldest attempt aging out', () => {
    let now = 1_000_000_000;
    const m = new Meter(() => now);
    for (let i = 0; i < 100; i++) m.recordFetchAttempt(now + i * 1000); // 100 attempts, 1/s
    now += 100_000;
    // The oldest attempt was at t0 = 1_000_000_000 → the window opens when
    // it ages out at t0 + 1h.
    expect(m.pagesBudgetWaitMs(100, now)).toBe(1_000_000_000 + 3_600_000 - now + 1);
    expect(m.pagesBudgetWaitMs(0, now)).toBe(0); // unlimited
  });

  it('bytes budget: 0 or negative limit = unlimited (cap fully off)', () => {
    const now = 9_000_000_000;
    const m = new Meter(() => now);
    m.recordFetch(500 * 1024 * 1024, now); // 500 MB this hour
    // The app's "Unlimited" setting maps maxBandwidthMB 0 → maxBytesPerHour 0.
    expect(m.bytesBudgetWaitMs(0, 16 * 1024, now)).toBe(0);
    expect(m.bytesBudgetWaitMs(-1, 16 * 1024, now)).toBe(0);
    // …while a real cap still blocks when blown.
    expect(m.bytesBudgetWaitMs(1_000_000, 16 * 1024, now)).toBeGreaterThan(0);
  });

  it('bytes/hour counts in-flight reservations toward the ceiling', () => {
    const now = 5_000_000_000;
    const m = new Meter(() => now);
    const limit = 1_000_000; // 1 MB/h
    m.recordFetch(600_000, now);
    expect(m.bytesBudgetWaitMs(limit, 16 * 1024, now)).toBe(0); // 400KB left
    const r1 = m.reserveBytes(300_000); // slot 1 in flight
    const r2 = m.reserveBytes(90_000); // slot 2 in flight
    // 600k done + 390k reserved = 990k → 16KB more does NOT fit.
    expect(m.bytesBudgetWaitMs(limit, 16 * 1024, now)).toBeGreaterThan(0);
    m.settleBytes(r1);
    expect(m.bytesBudgetWaitMs(limit, 16 * 1024, now)).toBe(0); // 310k headroom
    m.settleBytes(r2);
    expect(m.getReservedBytes()).toBe(0);
    m.settleBytes(r2); // double-settle is a no-op
    expect(m.getReservedBytes()).toBe(0);
  });

  it('bytesBudgetWaitMs walks the window to the freeing point', () => {
    const now = 7_000_000_000;
    const m = new Meter(() => now);
    const limit = 100_000;
    m.recordFetch(60_000, now - 1000); // ages out at now-1000+1h
    m.recordFetch(30_000, now - 500);
    // need 16k → must free 6k+16k-10k... used=90k, need 16k → free ≥6k+...
    // 90k + 16k - 100k = 6k → the first entry (60k) aging out suffices.
    expect(m.bytesBudgetWaitMs(limit, 16 * 1024, now)).toBe(now - 1000 + 3_600_000 - now + 1);
    expect(m.bytesBudgetWaitMs(0, 16 * 1024, now)).toBe(0); // unlimited
    expect(m.bytesBudgetWaitMs(10_000, 16 * 1024, now)).toBe(Number.POSITIVE_INFINITY); // never fits
  });

  it('reservations alone blocking → bounded poll wait (not stuck, not Infinity)', () => {
    const now = 9_000_000_000;
    const m = new Meter(() => now);
    const limit = 100_000;
    const r = m.reserveBytes(95_000); // everything in flight, nothing completed
    const wait = m.bytesBudgetWaitMs(limit, 16 * 1024, now);
    expect(wait).toBeGreaterThan(0);
    expect(Number.isFinite(wait)).toBe(true);
    m.settleBytes(r);
    expect(m.bytesBudgetWaitMs(limit, 16 * 1024, now)).toBe(0);
  });
});
