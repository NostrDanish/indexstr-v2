/**
 * scheduler.test.ts — port of indexstr limits.test.ts per-domain rate limit
 * tests against the slot-allocator Scheduler, plus the politeness invariants
 * from blueprint §3.1.
 */
import { describe, expect, test } from 'vitest';
import { Scheduler } from './scheduler';

describe('per-domain rate limit', () => {
  test('second request inside the window is refused', () => {
    const s = new Scheduler({ minIntervalPerDomainMs: 0, maxCrawlDelayMs: 60_000 });
    expect(s.canMakeRequest('https://example.com/a', 50)).toBe(true);
    expect(s.canMakeRequest('https://example.com/b', 50)).toBe(false);
  });

  test('different domains are independent', () => {
    const s = new Scheduler({ minIntervalPerDomainMs: 0, maxCrawlDelayMs: 60_000 });
    expect(s.canMakeRequest('https://a.com/', 50)).toBe(true);
    expect(s.canMakeRequest('https://b.com/', 50)).toBe(true);
  });

  test('window expiry releases the domain', async () => {
    const s = new Scheduler({ minIntervalPerDomainMs: 0, maxCrawlDelayMs: 60_000 });
    expect(s.canMakeRequest('https://example.com/', 30)).toBe(true);
    await new Promise((r) => setTimeout(r, 45));
    expect(s.canMakeRequest('https://example.com/', 30)).toBe(true);
  });
});

describe('politeness invariants (blueprint §3.1)', () => {
  test('invariant (i): ≤1 concurrent slot per domain, even with N slots', () => {
    const s = new Scheduler({
      minIntervalPerDomainMs: 0,
      maxCrawlDelayMs: 60_000,
      parallelism: 4,
    });
    expect(s.tryAcquire('https://example.com/a')).toBe(true);
    // Same domain: refused while in flight — the synchronous check+set
    // leaves no check-then-set race window.
    expect(s.tryAcquire('https://example.com/b')).toBe(false);
    // Different domain: allowed (slots only increase domain diversity).
    expect(s.tryAcquire('https://other.org/')).toBe(true);
    s.release('https://example.com/a');
    s.release('https://other.org/');
  });

  test('invariant (ii): robots crawl-delay is honored, capped at maxCrawlDelayMs', () => {
    const s = new Scheduler({ minIntervalPerDomainMs: 1000, maxCrawlDelayMs: 5000 });
    expect(s.intervalFor(undefined)).toBe(1000); // configured floor
    expect(s.intervalFor(3000)).toBe(3000); // robots delay wins when larger
    expect(s.intervalFor(999_000)).toBe(5000); // capped
  });

  test('timeUntilNextRequest counts down from the last request', () => {
    let now = 10_000;
    const s = new Scheduler({
      minIntervalPerDomainMs: 5000,
      maxCrawlDelayMs: 60_000,
      clock: () => now,
    });
    expect(s.timeUntilNextRequest('https://example.com/')).toBe(0);
    s.noteRequest('https://example.com/');
    now += 2000;
    expect(s.timeUntilNextRequest('https://example.com/')).toBe(3000);
    now += 3000;
    expect(s.timeUntilNextRequest('https://example.com/')).toBe(0);
  });

  test('cancel() releases the slot WITHOUT noting a request (budget-blocked dispatch)', () => {
    let now = 50_000;
    const s = new Scheduler({
      minIntervalPerDomainMs: 5000,
      maxCrawlDelayMs: 60_000,
      parallelism: 2,
      clock: () => now,
    });
    expect(s.tryAcquire('https://a.com/')).toBe(true);
    // Budget reservation failed right after the acquire → cancel: the slot
    // frees AND no request timestamp is recorded (the domain is immediately
    // re-acquirable — no phantom interval).
    s.cancel('https://a.com/');
    expect(s.tryAcquire('https://a.com/')).toBe(true);
    expect(s.tryAcquire('https://b.com/')).toBe(true);
    expect(s.tryAcquire('https://c.com/')).toBe(false); // slots full again
    // release() (unlike cancel) DOES note the completion.
    s.release('https://a.com/');
    expect(s.tryAcquire('https://c.com/')).toBe(true); // slot freed
    s.release('https://b.com/');
    s.release('https://c.com/');
    expect(s.tryAcquire('https://a.com/')).toBe(false); // interval running
    now += 5000;
    expect(s.tryAcquire('https://a.com/')).toBe(true);
  });

  test('global slot cap is honored', () => {
    const s = new Scheduler({
      minIntervalPerDomainMs: 0,
      maxCrawlDelayMs: 60_000,
      parallelism: 2,
    });
    expect(s.tryAcquire('https://a.com/')).toBe(true);
    expect(s.tryAcquire('https://b.com/')).toBe(true);
    expect(s.tryAcquire('https://c.com/')).toBe(false); // all slots busy
    s.release('https://a.com/');
    s.release('https://b.com/');
  });
});
