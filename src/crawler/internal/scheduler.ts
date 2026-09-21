/**
 * scheduler.ts — per-domain politeness + fetch-slot allocation.
 *
 * P3 runs the crawl loop as N parallel slot runners (default 4, max 8) over
 * this allocator:
 *
 *   - tryAcquire(url) is one synchronous check+set step on the main event
 *     loop, so per-domain seriality holds even with N slots (no
 *     check-then-set race — the hazard both v1 limits.ts files warned about).
 *   - Politeness invariants (asserted in tests):
 *       (i)   ≤1 concurrent request per domain, always;
 *       (ii)  ≥ minInterval (or robots crawl-delay, capped) between
 *             requests to one domain — robots/feed/sitemap fetches count
 *             (they go through noteRequest too);
 *       (iii) global budgets are enforced by the meter, not here;
 *       (iv)  more slots only increase domain-diversity utilization,
 *             never per-site rate.
 *   - When all slots are politeness-blocked the engine sleeps until the
 *     earliest unblock time (computed via timeUntilNextRequest, not polled).
 */

export interface SchedulerConfig {
  /** Default ms between requests to one domain (5000; 8000 eco). */
  minIntervalPerDomainMs: number;
  /** Cap on robots.txt crawl-delay (default 60_000). */
  maxCrawlDelayMs: number;
  /** Fetch slots (default 4, max 8). P1 uses 1. */
  parallelism?: number;
  clock?: () => number;
}

/** Hard cap on in-memory per-domain state (LRU-ish sweep beyond this). */
const MAX_DOMAIN_ENTRIES = 5000;

export class Scheduler {
  private readonly minInterval: number;
  private readonly maxCrawlDelay: number;
  private readonly clock: () => number;
  private readonly slots: number;
  private readonly domainLastRequest = new Map<string, number>();
  private readonly inFlightDomains = new Set<string>();
  private inFlight = 0;

  constructor(config: SchedulerConfig) {
    this.minInterval = config.minIntervalPerDomainMs;
    this.maxCrawlDelay = config.maxCrawlDelayMs;
    this.clock = config.clock ?? Date.now;
    this.slots = Math.max(1, Math.min(8, config.parallelism ?? 1));
  }

  /** Effective interval for a domain: max(configured, robots crawl-delay
   *  capped at maxCrawlDelayMs). */
  intervalFor(crawlDelayMs?: number): number {
    return Math.max(this.minInterval, Math.min(crawlDelayMs ?? 0, this.maxCrawlDelay));
  }

  /**
   * Try to acquire a fetch slot for `url` (synchronous check+set).
   * Returns true when the request may start NOW; the caller MUST pair every
   * successful acquire with exactly one release(url).
   */
  tryAcquire(url: string, crawlDelayMs?: number): boolean {
    if (this.inFlight >= this.slots) return false;
    const domain = this.domainOf(url);
    if (this.inFlightDomains.has(domain)) return false; // invariant (i)
    const last = this.domainLastRequest.get(domain) ?? 0;
    if (this.clock() - last < this.intervalFor(crawlDelayMs)) return false; // (ii)

    this.inFlight++;
    this.inFlightDomains.add(domain);
    return true;
  }

  /** P1 serial-loop compatibility: true when a request to `url` may start.
   *  Records the attempt timestamp on success (v1 canMakeRequest semantics —
   *  no in-flight tracking for the serial path). */
  canMakeRequest(url: string, crawlDelayMs?: number): boolean {
    const domain = this.domainOf(url);
    const last = this.domainLastRequest.get(domain) ?? 0;
    if (this.clock() - last < this.intervalFor(crawlDelayMs)) return false;
    this.noteRequest(url);
    return true;
  }

  /** Record a completed request to `url`'s domain (starts the interval).
   *  Robots/feed/sitemap/probe requests call this too — discovery traffic
   *  is same-origin load and counts toward politeness. */
  noteRequest(url: string): void {
    const domain = this.domainOf(url);
    this.domainLastRequest.set(domain, this.clock());
    // Size cap: sweep the oldest half when the map grows unbounded.
    if (this.domainLastRequest.size > MAX_DOMAIN_ENTRIES) {
      const entries = [...this.domainLastRequest.entries()].sort((a, b) => a[1] - b[1]);
      for (const [d] of entries.slice(0, Math.floor(entries.length / 2))) {
        this.domainLastRequest.delete(d);
      }
    }
  }

  /** Release a slot acquired via tryAcquire. Notes the request COMPLETION —
   *  the per-domain interval restarts from here. */
  release(url: string): void {
    const domain = this.domainOf(url);
    if (this.inFlightDomains.delete(domain)) this.inFlight--;
    this.noteRequest(url);
  }

  /** Release a slot acquired via tryAcquire WITHOUT noting a request — the
   *  dispatch was aborted before any request was made (e.g. the budget
   *  reservation failed right after the acquire). */
  cancel(url: string): void {
    const domain = this.domainOf(url);
    if (this.inFlightDomains.delete(domain)) this.inFlight--;
  }

  /** Ms until a request to `url` would be allowed (0 = now). */
  timeUntilNextRequest(url: string, crawlDelayMs?: number): number {
    const domain = this.domainOf(url);
    const last = this.domainLastRequest.get(domain) ?? 0;
    const elapsed = this.clock() - last;
    return Math.max(0, this.intervalFor(crawlDelayMs) - elapsed);
  }

  private domainOf(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  /** Test hook: clear all state. */
  reset(): void {
    this.domainLastRequest.clear();
    this.inFlightDomains.clear();
    this.inFlight = 0;
  }
}
