/**
 * Resource metering — one accounting point for EVERY byte the crawler moves.
 *
 * The meter is fed exclusively by net.ts (the guardedFetch choke point), so
 * pages, robots.txt, feeds, sitemaps, NIP-11 probes, proxy overhead and
 * failed/oversize downloads ALL count toward the budget. Bytes are real
 * stream bytes (Uint8Array length), not UTF-16 string lengths — CJK pages
 * no longer undercount ~3×.
 *
 * Instance-based (no module globals): each CrawlerNode owns its meter.
 */

const HOUR_MS = 3_600_000;

interface ByteEntry {
  at: number;
  bytes: number;
}

/**
 * A byte reservation taken at request DISPATCH (reserve-on-dispatch, P3).
 * With N fetch slots running concurrently, a check-then-fetch pattern lets
 * each slot see the same headroom and collectively overshoot the bytes/hour
 * window by up to N × page size. Reserving the fetch's byte cap at dispatch
 * (and settling at completion) makes the budget a hard ceiling: the sum of
 * completed bytes + in-flight reservations never exceeds the limit.
 */
export interface ByteReservation {
  bytes: number;
}

export class Meter {
  /** Sliding window of every fetch's byte count. */
  private byteWindow: ByteEntry[] = [];
  /** Sliding window of fetch attempts (for pages/hour). */
  private attemptWindow: number[] = [];
  /** Sliding window of successfully processed pages. */
  private pageWindow: number[] = [];
  private sessionBytes = 0;
  private sessionFetches = 0;
  /** Bytes reserved by in-flight fetches (see ByteReservation). */
  private reservedBytes = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  private static prune(window: { at: number }[], now: number): void {
    const cutoff = now - HOUR_MS;
    while (window.length > 0 && window[0]!.at < cutoff) window.shift();
  }

  private static pruneTimes(window: number[], now: number): void {
    const cutoff = now - HOUR_MS;
    while (window.length > 0 && window[0]! < cutoff) window.shift();
  }

  /** Record bytes for any fetch — page, feed, sitemap, robots, probe. */
  recordFetch(bytes: number, at = this.clock()): void {
    this.byteWindow.push({ at, bytes });
    this.sessionBytes += bytes;
    this.sessionFetches++;
    Meter.prune(this.byteWindow, at);
    if (this.byteWindow.length > 8192) {
      this.byteWindow = this.byteWindow.filter((e) => at - e.at < HOUR_MS);
    }
  }

  /** Record that a page fetch was attempted (success or failure). */
  recordFetchAttempt(at = this.clock()): void {
    this.attemptWindow.push(at);
    Meter.pruneTimes(this.attemptWindow, at);
    if (this.attemptWindow.length > 4096) {
      this.attemptWindow = this.attemptWindow.filter((t) => at - t < HOUR_MS);
    }
  }

  /** Record a successfully processed page (for the pages/hour budget). */
  recordPage(at = this.clock()): void {
    this.pageWindow.push(at);
    Meter.pruneTimes(this.pageWindow, at);
  }

  /** Bytes moved in the last hour across ALL traffic. */
  bytesLastHour(now = this.clock()): number {
    Meter.prune(this.byteWindow, now);
    return this.byteWindow.reduce((sum, e) => sum + e.bytes, 0);
  }

  /** Page fetch attempts in the last hour. */
  attemptsLastHour(now = this.clock()): number {
    Meter.pruneTimes(this.attemptWindow, now);
    return this.attemptWindow.length;
  }

  /** True when the configured pages/hour budget is exhausted. */
  pagesPerHourExceeded(limit: number, now = this.clock()): boolean {
    if (limit <= 0) return false; // 0 = unlimited
    return this.attemptsLastHour(now) >= limit;
  }

  /**
   * Ms until the pages/hour window has headroom again (0 = a request may
   * start now). Pure check — pair with recordFetchAttempt() in ONE
   * synchronous step (reserve-on-dispatch) so the window is a hard ceiling
   * even with parallel slots (spike finding #7: recording at completion
   * lets N in-flight slots overshoot the window by up to N).
   */
  pagesBudgetWaitMs(limit: number, now = this.clock()): number {
    if (limit <= 0) return 0;
    if (!this.pagesPerHourExceeded(limit, now)) return 0;
    // The window opens when the OLDEST attempt in it ages out.
    return Math.max(1, this.attemptWindow[0]! + HOUR_MS - now + 1);
  }

  /**
   * Ms until the bytes/hour budget can fit `needBytes` more (0 = fits now),
   * accounting for BOTH completed bytes and in-flight reservations. Pure
   * check — pair with reserveBytes() synchronously.
   */
  bytesBudgetWaitMs(limitBytes: number, needBytes: number, now = this.clock()): number {
    if (limitBytes <= 0) return 0;
    if (needBytes > limitBytes) return Number.POSITIVE_INFINITY; // can never fit
    const used = this.bytesLastHour(now) + this.reservedBytes;
    if (used + needBytes <= limitBytes) return 0;
    // Walk the window oldest-first: when do enough completed bytes age out?
    let freed = 0;
    for (const entry of this.byteWindow) {
      freed += entry.bytes;
      if (used - freed + needBytes <= limitBytes) {
        return Math.max(1, entry.at + HOUR_MS - now + 1);
      }
    }
    // Completed bytes alone can't free enough — in-flight reservations must
    // settle first; their completion time isn't known here, so poll.
    return 5_000;
  }

  /**
   * Reserve `bytes` against the bytes/hour budget for an in-flight fetch.
   * MUST be settled exactly once via settleBytes() (success or failure).
   */
  reserveBytes(bytes: number): ByteReservation {
    this.reservedBytes += bytes;
    return { bytes };
  }

  /** Release a dispatch-time byte reservation (fetch settled). */
  settleBytes(reservation: ByteReservation): void {
    this.reservedBytes = Math.max(0, this.reservedBytes - reservation.bytes);
    reservation.bytes = 0; // double-settle is a no-op
  }

  /** Bytes currently reserved by in-flight fetches (test/observability). */
  getReservedBytes(): number {
    return this.reservedBytes;
  }

  /** Pages fetched in the last hour. */
  pagesLastHour(now = this.clock()): number {
    Meter.pruneTimes(this.pageWindow, now);
    return this.pageWindow.length;
  }

  /** Session totals (for the dashboard display). */
  getSessionTotals(): { bytes: number; fetches: number } {
    return { bytes: this.sessionBytes, fetches: this.sessionFetches };
  }

  /** Remaining bytes this hour under a budget (bytes). */
  remainingBytesThisHour(limitBytes: number, now = this.clock()): number {
    return Math.max(0, limitBytes - this.bytesLastHour(now));
  }

  /** Test hook: clear all accounting. */
  reset(): void {
    this.byteWindow = [];
    this.attemptWindow = [];
    this.pageWindow = [];
    this.sessionBytes = 0;
    this.sessionFetches = 0;
    this.reservedBytes = 0;
  }
}
