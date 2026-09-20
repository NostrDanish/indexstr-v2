/**
 * engine.ts — crawl orchestration / state machine. INTERNAL.
 *
 * The ordering invariant (the P0 bug class) is structural here:
 *
 *   crawlUrl(job):
 *     1. SSRF admission check (guard)        ← BEFORE any request
 *     2. freshness gate (recrawl due?)
 *     3. robots.txt via Robots (no own fetch — goes through net.ts, which
 *        re-runs the guard; robots.ts physically cannot bypass it)
 *     4. fetch via Net.guardedFetchPage      ← guard runs again inside
 *     5. parse/hash via WorkerPool
 *     6. enrich (optional) → freshness → storage txn → publish lane
 *
 * Plus admission-time validation: EVERY enqueue source (seeds, discovered
 * links, feed entries, sitemaps, network intake) funnels through admit():
 * normalize → guard → traps → dedup → queue-cap check. Private URLs never
 * enter the queue from anywhere (F1's remote trigger dies at admission).
 *
 * P3: the loop is EVENT-DRIVEN around the parallel slot scheduler —
 * `politeness.parallelism` slot runners (default 4, max 8), each looping
 * dispatchOnce(): pick a ready job → robots warm-up as a scheduled request
 * on the same domain lane → sync tryAcquire (per-domain serial + interval,
 * crawl-delay capped) → sync budget reserve-on-dispatch → claim + crawl →
 * release. Blocked slots sleep until the computed earliest unblock time
 * (never polled); new admissions wake sleepers. Politeness invariants:
 *   (i)   ≤1 concurrent request per domain (sync check+set — no race);
 *   (ii)  ≥ interval between requests to one domain, robots/feed/sitemap
 *         fetches INCLUDED (they occupy the same scheduler lane);
 *   (iii) budgets are hard ceilings (reserve-on-dispatch, see meter.ts);
 *   (iv)  more slots only increase domain-diversity utilization.
 */

import type { NostrEvent } from '@nostrify/nostrify';
import { normalizeIndexUrl } from '@sip01/protocol';

import { retryBackoffMs } from './backoff';
import { isPubliclyFetchable } from './guard';
import { Meter, type ByteReservation } from './meter';
import { Net, type FetchOutcome } from './net';
import { Robots } from './robots';
import { Scheduler } from './scheduler';
import type { CrawlerStorage } from './storage';
import { NEGATIVE_CACHE_TTL_MS } from './storage';
import { nextFreshness } from './freshness';
import { Publisher } from './publisher';
import { WorkerPool, hashContent } from './workerpool';
import { urlShard, nodeShard, CROSS_SHARD_SAMPLING } from './sharding';
import {
  buildHeartbeat,
  dedupeHeartbeats,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_KIND,
  HEARTBEAT_TTL_S,
  type HeartbeatConfig,
  type ParsedHeartbeat,
} from './heartbeat';
import { isLikelyCrawlTrap, DomainIntakeGuard } from './modules/traps';
import { Discovery } from './modules/discovery';
import { NetworkIntake } from './modules/intake';
import type {
  CrawlJob,
  CrawledRecord,
  CrawlerStats,
  ParsedPage,
  PersistedStats,
  ResolvedConfig,
} from './types';
import { emptyStats } from './types';

/** Per-domain cap for discovered links (collections/seeds exempt). */
const DISCOVERY_DOMAIN_CAP = 500;
/** How often the outbox flush retries while running. */
const OUTBOX_FLUSH_INTERVAL_MS = 5 * 60 * 1000;
/** Default network-intake poll interval. */
const DEFAULT_INTAKE_INTERVAL_MS = 120_000;
/** Max RE-attempts for transient failures (permanent failures: 0). */
const MAX_TRANSIENT_RETRIES = 3;
/** How often storage maintenance runs (crawled eviction + negative-cache
 *  TTL sweep). Also runs once at start. */
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
/** stop() grace period for draining the in-flight publish lane. */
const PUBLISH_DRAIN_GRACE_MS = 2_000;

export type CrawlerEvent =
  | { type: 'stats'; stats: CrawlerStats }
  | { type: 'observation'; url: string; delivered: number }
  | { type: 'error'; error: unknown };

type Listener = (event: CrawlerEvent) => void;

/** Map well-known hosts to SIP-01 §9.2 `platform` extension values.
 *  Deliberately small — an unrecognised host simply gets no platform tag. */
function detectPlatform(host: string): string | undefined {
  const h = host.toLowerCase();
  if (h === 'github.com' || h.endsWith('.github.com') || h.endsWith('.github.io')) return 'github';
  if (h === 'gitlab.com' || h.endsWith('.gitlab.com')) return 'gitlab';
  if (h === 'youtube.com' || h === 'youtu.be' || h.endsWith('.youtube.com')) return 'youtube';
  if (h === 'wikipedia.org' || h.endsWith('.wikipedia.org')) return 'wikipedia';
  if (h === 'medium.com' || h.endsWith('.medium.com')) return 'medium';
  if (h === 'dev.to') return 'devto';
  if (h === 'news.ycombinator.com') return 'hackernews';
  if (h.endsWith('.reddit.com') || h === 'reddit.com') return 'reddit';
  if (h === 'stackoverflow.com' || h.endsWith('.stackexchange.com')) return 'stackoverflow';
  return undefined;
}

export class Engine {
  readonly homeShard: number;

  private readonly meter: Meter;
  private readonly net: Net;
  private readonly robots: Robots;
  private readonly scheduler: Scheduler;
  private readonly publisher: Publisher;
  private readonly pool: WorkerPool;
  private readonly discovery: Discovery;
  private readonly intake: NetworkIntake | null;

  private running = false;
  private startTime = 0;
  private stats: CrawlerStats = emptyStats();
  private abortController: AbortController | null = null;
  private listeners = new Set<Listener>();

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private intakeTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private onlineHandler: (() => void) | null = null;

  /** Domain of the previously crawled job — fair scheduling. */
  private lastDomain = '';
  /** Wake hooks for sleeping slot runners (event-driven dispatch). */
  private readonly wakeListeners = new Set<() => void>();
  /** In-flight publish lane promises (fire-and-track, P3). */
  private readonly publishLane = new Set<Promise<void>>();
  private readonly discoveryGuard = new DomainIntakeGuard(DISCOVERY_DOMAIN_CAP);
  /** Origins already probed for sitemaps this session. */
  private probedSitemaps = new Set<string>();
  /** Feeds already followed this session. */
  private followedFeeds = new Set<string>();

  constructor(
    private readonly config: ResolvedConfig,
    private readonly storage: CrawlerStorage,
  ) {
    const clock = config.clock;
    this.homeShard = nodeShard(config.indexerPubkey);
    // The host may share its meter with other lanes (relay probe) so every
    // byte the node moves counts toward the same budget.
    this.meter = config.meter ?? new Meter(clock);
    this.net = new Net({
      fetchFn: config.fetchFn,
      proxyTemplate: config.proxyTemplate,
      meter: this.meter,
    });
    this.robots = new Robots(this.net, clock);
    this.scheduler = new Scheduler({
      minIntervalPerDomainMs: config.politeness.minIntervalPerDomainMs,
      maxCrawlDelayMs: config.politeness.maxCrawlDelayMs,
      parallelism: config.politeness.parallelism,
      clock,
    });
    this.publisher = new Publisher({
      signer: config.signer,
      publish: config.publish,
      relays: config.relays.publish,
      storage,
      clock,
    });
    this.pool = new WorkerPool(config.workerCount);
    this.discovery = new Discovery(
      this.net,
      (origin) => this.robots.getSitemaps(origin),
      config.crawl.ecoMode ? 10 : 25,
    );
    this.intake =
      config.modules.intake.enabled && config.intakeQuery
        ? new NetworkIntake({
            query: config.intakeQuery,
            ownPubkey: config.indexerPubkey,
            isKnown: async (url) =>
              (await this.storage.getCrawled(url)) !== undefined ||
              (await this.storage.isQueued(url)),
            enqueue: async (url) =>
              (await this.admit(url, {
                priority: 0.5,
                followLinks: false,
                discoveredFrom: 'nostr:network',
                applyTraps: false, // intake already ran the trap heuristic
              })) === 'queued',
            clock,
          })
        : null;
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  on(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(event: CrawlerEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        // Listener errors must never break the loop.
      }
    }
  }

  private emitStats(): void {
    this.stats.uptime = this.running
      ? Math.floor((this.config.clock() - this.startTime) / 1000)
      : 0;
    // The meter counts EVERY byte (pages, robots, feeds, sitemaps, relay
    // probes) — keep the dashboard snapshot in sync, not just on crawls.
    this.stats.bandwidthUsed = this.meter.getSessionTotals().bytes;
    this.emit({ type: 'stats', stats: { ...this.stats } });
  }

  getStats(): CrawlerStats {
    return { ...this.stats };
  }

  /* ------------------------------------------------------------------ */
  /* Read/maintenance surface (dashboard history, clear buttons)         */
  /* ------------------------------------------------------------------ */

  /**
   * Recently crawled pages, newest first (the History tab). Real fetches
   * only by default; `includeObserved`/`includeFailed` widen the window.
   */
  recentCrawls(
    limit = 20,
    opts?: { includeObserved?: boolean; includeFailed?: boolean },
  ): Promise<CrawledRecord[]> {
    const include: Array<CrawledRecord['status']> = ['fetched'];
    if (opts?.includeObserved) include.push('observed');
    if (opts?.includeFailed) include.push('failed');
    return this.storage.recentCrawled(limit, include);
  }

  /**
   * Persisted store counts for pre-start display (v1 loaded these in
   * init()). Session stats stay zero until start() rehydrates them.
   */
  async persistedStats(): Promise<PersistedStats> {
    const [queueSize, pagesIndexed, outboxPending] = await Promise.all([
      this.storage.queueSize(),
      this.storage.crawledCount(),
      this.storage.outboxSize(),
    ]);
    const homeShardJobs = this.config.modules.sharding.enabled
      ? await this.storage.queueShardCount(this.homeShard)
      : 0;
    return { queueSize, pagesIndexed, outboxPending, homeShardJobs };
  }

  /** Clear the crawl queue (crawled history and the outbox are kept). */
  async clearQueue(): Promise<void> {
    await this.storage.clearQueue();
    this.stats.queueSize = 0;
    this.stats.homeShardJobs = 0;
    this.emitStats();
  }

  /**
   * Wipe ALL local crawler state: queue, crawled history (including the
   * negative cache — cleared failures will be re-fetched on the next
   * encounter) and the outbox (unpublished observations are discarded).
   */
  async clearAll(): Promise<void> {
    await this.storage.clearAll();
    this.stats.queueSize = 0;
    this.stats.homeShardJobs = 0;
    this.stats.pagesIndexed = 0;
    this.stats.outboxPending = 0;
    this.emitStats();
  }

  /**
   * Read the network's recent node heartbeats (kind 16919) through the
   * host-injected heartbeatQuery transport; deduped latest-per-node,
   * newest first. Returns [] when no heartbeatQuery transport is
   * configured — a single-user scout doesn't need the network view.
   */
  async networkHeartbeats(): Promise<ParsedHeartbeat[]> {
    const query = this.config.heartbeatQuery;
    if (!query) return [];
    const since = Math.floor(this.config.clock() / 1000) - HEARTBEAT_TTL_S * 2;
    const events = await query([{ kinds: [HEARTBEAT_KIND], since, limit: 500 }]);
    return dedupeHeartbeats(events);
  }

  /* ------------------------------------------------------------------ */
  /* Admission — the ONE path every enqueue source funnels through       */
  /* ------------------------------------------------------------------ */

  /**
   * admit(): normalize → guard (SSRF) → traps → dedup → queue-cap → insert.
   * Private URLs never enter the queue from seeds, links, feeds, sitemaps,
   * or network intake.
   */
  async admit(
    rawUrl: string,
    opts: {
      priority: number;
      depth?: number;
      followLinks?: boolean;
      discoveredFrom?: string;
      applyTraps?: boolean;
    },
  ): Promise<'queued' | 'duplicate' | 'rejected'> {
    const normalized = normalizeIndexUrl(rawUrl);
    if (!normalized) return 'rejected';

    // SSRF queue-admission check (F1 fix, structural).
    if (!isPubliclyFetchable(normalized)) {
      this.stats.ssrfBlocked++;
      return 'rejected';
    }

    if (opts.applyTraps && this.config.modules.traps.enabled) {
      if (isLikelyCrawlTrap(normalized)) {
        this.stats.trapsBlocked++;
        return 'rejected';
      }
    }

    // Dedup (queue + crawled + negative cache) before the queue-cap check
    // (blueprint §7). 'observed' entries (feed/sitemap-derived) never block
    // admission — a real fetch may still be worthwhile. 'failed' negatives
    // block re-admission until their 7-day TTL expires: past the TTL the
    // URL is re-admissible even before the periodic sweep evicts the entry
    // (permanent failures are cached, not eternal).
    const existing = await this.storage.getCrawled(normalized);
    if (existing) {
      if (
        existing.status === 'failed' &&
        existing.crawledAt + NEGATIVE_CACHE_TTL_MS > this.config.clock()
      ) {
        return 'duplicate';
      }
      if (
        existing.status === 'fetched' &&
        (existing.recrawlDue ?? Number.POSITIVE_INFINITY) > this.config.clock()
      ) {
        return 'duplicate';
      }
    }

    // Queue-cap check in the single admit path (F7 fix).
    if ((await this.storage.queueSize()) >= this.config.crawl.maxQueueSize) return 'rejected';

    await this.storage.putJob({
      url: normalized,
      priority: opts.priority,
      depth: opts.depth ?? 0,
      attempts: 0,
      followLinks: opts.followLinks ?? true,
      discoveredFrom: opts.discoveredFrom,
      shard: urlShard(normalized),
    });
    this.wake(); // event-driven dispatch: idle/blocked slots re-pick now
    return 'queued';
  }

  /**
   * Batched admission for link discovery (P3, blueprint §3.1 "IDB
   * discipline"): the per-page link set goes through the SAME checks as
   * admit() (normalize → guard → traps → dedup → queue cap) but the writes
   * land in ONE chunked transaction (storage.putJobs) instead of per-link
   * putJob round-trips. Dedup reads are per-key (parallel getCrawled), and
   * the queue-cap headroom is computed ONCE per batch.
   */
  async admitMany(
    rawUrls: string[],
    opts: {
      priority: number;
      depth?: number;
      followLinks?: boolean;
      discoveredFrom?: string;
      applyTraps?: boolean;
    },
  ): Promise<{ queued: number; duplicates: number; rejected: number }> {
    let duplicates = 0;
    let rejected = 0;
    const now = this.config.clock();

    // 1. Synchronous stage: normalize → SSRF guard → traps.
    const candidates: string[] = [];
    const seen = new Set<string>();
    for (const rawUrl of rawUrls) {
      const normalized = normalizeIndexUrl(rawUrl);
      if (!normalized || seen.has(normalized)) {
        rejected++;
        continue;
      }
      seen.add(normalized);
      if (!isPubliclyFetchable(normalized)) {
        this.stats.ssrfBlocked++;
        rejected++;
        continue;
      }
      if (opts.applyTraps && this.config.modules.traps.enabled && isLikelyCrawlTrap(normalized)) {
        this.stats.trapsBlocked++;
        rejected++;
        continue;
      }
      candidates.push(normalized);
    }
    if (candidates.length === 0) return { queued: 0, duplicates, rejected };

    // 2. Dedup against crawled incl. the negative cache (TTL-aware, same
    // semantics as admit()). Per-key reads, batched in parallel.
    const existing = await Promise.all(
      candidates.map((url) => this.storage.getCrawled(url)),
    );
    const fresh: string[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const record = existing[i];
      if (
        record &&
        ((record.status === 'failed' && record.crawledAt + NEGATIVE_CACHE_TTL_MS > now) ||
          (record.status === 'fetched' &&
            (record.recrawlDue ?? Number.POSITIVE_INFINITY) > now))
      ) {
        duplicates++;
        continue;
      }
      fresh.push(candidates[i]!);
    }
    if (fresh.length === 0) return { queued: 0, duplicates, rejected };

    // 3. Queue-cap headroom computed once per batch (F7), then ONE chunked
    // transaction for the whole page's link set.
    const headroom = this.config.crawl.maxQueueSize - (await this.storage.queueSize());
    const admitted = fresh.slice(0, Math.max(0, headroom));
    rejected += fresh.length - admitted.length;
    if (admitted.length > 0) {
      await this.storage.putJobs(
        admitted.map((url) => ({
          url,
          priority: opts.priority,
          depth: opts.depth ?? 0,
          attempts: 0,
          followLinks: opts.followLinks ?? true,
          discoveredFrom: opts.discoveredFrom,
          shard: urlShard(url),
        })),
      );
      this.wake(); // event-driven dispatch: idle/blocked slots re-pick now
    }
    return { queued: admitted.length, duplicates, rejected };
  }

  /**
   * Seed URLs through the admission path. Manual seeds self-expand
   * (followLinks defaults to true); curated collections pass
   * `followLinks: false` — the collection IS the crawl plan, so its URLs
   * are indexed exactly as listed instead of exploding outward.
   */
  async seed(
    urls: string[],
    opts?: { priority?: number; followLinks?: boolean },
  ): Promise<{ admitted: number; rejected: number }> {
    let admitted = 0;
    let rejected = 0;
    for (const url of urls) {
      const result = await this.admit(url, {
        priority: opts?.priority ?? 1.0,
        followLinks: opts?.followLinks ?? true,
        applyTraps: false, // seeds are human-directed; traps apply to discovery
      });
      if (result === 'queued') admitted++;
      else rejected++;
    }
    this.stats.queueSize = await this.storage.queueSize();
    this.emitStats();
    return { admitted, rejected };
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startTime = this.config.clock();
    this.abortController = new AbortController();

    this.stats.queueSize = await this.storage.queueSize();
    this.stats.pagesIndexed = await this.storage.crawledCount();
    this.stats.outboxPending = await this.storage.outboxSize();
    if (this.config.modules.sharding.enabled) {
      this.stats.homeShardJobs = await this.storage.queueShardCount(this.homeShard);
    }
    this.emitStats();

    // Flush anything held from an offline period — now, periodically, and
    // the moment connectivity returns.
    void this.flushOutbox();
    this.outboxTimer = setInterval(() => void this.flushOutbox(), OUTBOX_FLUSH_INTERVAL_MS);
    if (typeof window !== 'undefined') {
      this.onlineHandler = () => void this.flushOutbox();
      window.addEventListener('online', this.onlineHandler);
    }

    // Heartbeat side-channel (kind 16919) — optional module.
    if (this.config.modules.heartbeat.enabled) {
      void this.publishHeartbeat();
      this.heartbeatTimer = setInterval(
        () => void this.publishHeartbeat(),
        this.config.modules.heartbeat.intervalMs || HEARTBEAT_INTERVAL_MS,
      );
    }

    // Network intake side-channel — optional module.
    if (this.intake) {
      const interval = this.config.modules.intake.intervalMs || DEFAULT_INTAKE_INTERVAL_MS;
      this.intakeTimer = setInterval(() => void this.networkIntake(), interval);
      setTimeout(() => {
        if (this.running) void this.networkIntake();
      }, 15_000);
    }

    // Storage maintenance: bounded-growth eviction now and periodically.
    void this.runMaintenance();
    this.maintenanceTimer = setInterval(
      () => void this.runMaintenance(),
      MAINTENANCE_INTERVAL_MS,
    );

    // Spawn the parallel slot runners (event-driven crawl loop, P3).
    for (let i = 0; i < this.config.politeness.parallelism; i++) {
      void this.runSlot();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    if (this.intakeTimer) clearInterval(this.intakeTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.heartbeatTimer = null;
    this.outboxTimer = null;
    this.intakeTimer = null;
    this.maintenanceTimer = null;
    if (this.onlineHandler && typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineHandler);
      this.onlineHandler = null;
    }
    // Drain the publish lane with a grace period — a hanging relay must not
    // hang shutdown either. Zero-ack events are safe (the publisher outboxes
    // them); only never-RESOLVING publishes are abandoned — a recrawl can
    // always reproduce the observation.
    if (this.publishLane.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.publishLane]),
        new Promise((resolve) => setTimeout(resolve, PUBLISH_DRAIN_GRACE_MS)),
      ]);
    }
    await this.pool.dispose();
    this.emitStats();
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Per-relay publish health snapshot (for the host UI). */
  relayHealth(): ReturnType<Publisher['getRelayHealth']> {
    return this.publisher.getRelayHealth();
  }

  /* ------------------------------------------------------------------ */
  /* Side channels                                                       */
  /* ------------------------------------------------------------------ */

  /** Deliver held observations; update stats. */
  async flushOutbox(): Promise<number> {
    try {
      const delivered = await this.publisher.flushObservationOutbox();
      if (delivered > 0) this.stats.published += delivered;
      this.stats.outboxPending = await this.storage.outboxSize();
      this.emitStats();
      return delivered;
    } catch (error) {
      this.emit({ type: 'error', error });
      return 0;
    }
  }

  /**
   * Storage maintenance: sweep expired negative-cache entries (7-day TTL)
   * and evict the crawled store down to its soft cap (oldest-first, never
   * touching live recrawl state). Runs at start and hourly while running;
   * safe to call any time.
   */
  async runMaintenance(): Promise<{ evicted: number; expiredFailures: number }> {
    const now = this.config.clock();
    const expiredFailures = await this.storage.sweepExpiredFailures(now);
    const evicted = await this.storage.evictCrawled(now);
    if (evicted + expiredFailures > 0) {
      this.stats.pagesIndexed = await this.storage.crawledCount();
      this.emitStats();
    }
    return { evicted, expiredFailures };
  }

  /** Sign and publish a kind 16919 heartbeat to the publish relay set. */
  private async publishHeartbeat(): Promise<void> {
    try {
      const hbConfig: HeartbeatConfig = {
        source: this.config.source,
        indexerPubkey: this.config.indexerPubkey,
        signer: this.config.signer,
        clock: this.config.clock,
      };
      const event = await buildHeartbeat(
        {
          pagesIndexed: this.stats.pagesIndexed,
          queueSize: this.stats.queueSize,
          published: this.stats.published,
        },
        hbConfig,
      );
      await this.publisher.publishHeartbeatEvent(event);
    } catch (error) {
      this.emit({ type: 'error', error });
    }
  }

  /** One network-intake poll (module-enabled only). */
  async networkIntake(): Promise<void> {
    if (!this.intake || !this.running) return;
    if ((await this.storage.queueSize()) >= this.config.crawl.maxQueueSize) return;

    const result = await this.intake.poll();
    if (result.accepted > 0 || result.rejected > 0) {
      this.stats.networkIntake += result.accepted;
      this.stats.intakeRejected += result.rejected;
      this.stats.ssrfBlocked += result.ssrfBlocked;
      this.stats.trapsBlocked += result.trapsBlocked;
      this.stats.queueSize = await this.storage.queueSize();
      if (this.config.modules.sharding.enabled) {
        this.stats.homeShardJobs = await this.storage.queueShardCount(this.homeShard);
      }
      this.emitStats();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Crawl loop                                                          */
  /* ------------------------------------------------------------------ */

  private async canCrawl(): Promise<boolean> {
    // Battery / network gates (browser-only, guarded).
    if (typeof navigator !== 'undefined' && 'getBattery' in navigator) {
      try {
        const battery = await (
          navigator as unknown as {
            getBattery(): Promise<{ level: number; charging: boolean }>;
          }
        ).getBattery();
        if (battery.level < 0.15 && !battery.charging) return false;
      } catch {
        // Battery API not available, continue
      }
    }

    // Global budgets (pages/hour + bytes/hour) are enforced at DISPATCH in
    // the crawl loop (reserve-on-dispatch, P3) — not here, so the check and
    // the reservation are one synchronous step with no interleaving window.
    return true;
  }

  /**
   * One parallel slot runner (P3). Loops dispatchOnce() and sleeps the
   * computed wait when politeness-blocked / budget-blocked / idle — sleeps
   * end early when new work is admitted (wake) or the node stops (abort).
   */
  private async runSlot(): Promise<void> {
    while (this.running) {
      try {
        const waitMs = await this.dispatchOnce();
        if (waitMs > 0 && this.running) await this.sleep(waitMs);
      } catch (error) {
        this.stats.errors++;
        this.emit({ type: 'error', error });
        this.emitStats();
        await this.sleep(10_000);
      }
    }
  }

  /**
   * A single dispatch attempt for one slot. Returns the ms the slot should
   * sleep before retrying (0 = dispatch again immediately).
   *
   * Ordering is the invariant story: politeness acquire (sync check+set) →
   * budget reservation (sync check+set, still in the same tick) → claim the
   * job → crawl → release. No await sits between the checks and the
   * reservations, so concurrent slots can never observe the same headroom.
   */
  private async dispatchOnce(): Promise<number> {
    if (!(await this.canCrawl())) return 10_000; // battery gate (host policy)

    const job = await this.storage.nextJob(
      this.config.modules.sharding.enabled ? this.homeShard : undefined,
      CROSS_SHARD_SAMPLING,
      this.lastDomain || undefined,
    );
    if (!job) return 5000; // idle — woken early by admit()/seed()

    // robots.txt is a SCHEDULED request on the same per-domain lane
    // (invariant ii: discovery traffic counts toward the interval). The
    // page job stays queued; the next dispatch finds the rules cached.
    if (this.config.politeness.respectRobots && !this.robots.hasCachedRules(job.url)) {
      const robotsUrl = Robots.robotsUrlFor(job.url);
      if (!robotsUrl) return this.deferJob(job, 60_000); // unparseable — crawlUrl's guard refuses it
      if (!this.scheduler.tryAcquire(robotsUrl)) {
        return this.deferJob(job, this.scheduler.timeUntilNextRequest(robotsUrl));
      }
      try {
        await this.robots.warm(job.url);
      } finally {
        this.scheduler.release(robotsUrl); // notes completion — interval starts
      }
      return 0;
    }

    const crawlDelay = this.config.politeness.respectRobots
      ? this.robots.peekCrawlDelay(job.url)
      : 0;

    // Politeness: slot capacity + per-domain seriality + min interval /
    // crawl-delay (capped). Synchronous check+set — no race window.
    if (!this.scheduler.tryAcquire(job.url, crawlDelay)) {
      return this.deferJob(job, this.scheduler.timeUntilNextRequest(job.url, crawlDelay));
    }

    // Budgets: reserve-on-dispatch (spike finding #7 — recording pages at
    // COMPLETION lets N in-flight slots overshoot the pages/hour window by
    // up to N). Wait-check, page-attempt reservation and byte reservation
    // are ONE synchronous step right after the acquire: the sliding windows
    // are hard ceilings regardless of parallelism (invariant iii).
    const budgetWait = Math.max(
      this.meter.pagesBudgetWaitMs(this.config.budgets.maxPagesPerHour),
      this.meter.bytesBudgetWaitMs(this.config.budgets.maxBytesPerHour, 16 * 1024),
    );
    if (budgetWait > 0) {
      this.scheduler.cancel(job.url); // no request made — don't note one
      return this.deferJob(job, Number.isFinite(budgetWait) ? budgetWait : 60_000);
    }
    this.meter.recordFetchAttempt();
    const byteBudget = this.config.budgets.maxBytesPerHour;
    const reservation = this.meter.reserveBytes(
      Math.min(
        this.config.budgets.maxPageSizeKB * 1024,
        byteBudget > 0
          ? Math.max(
              0,
              byteBudget - this.meter.bytesLastHour() - this.meter.getReservedBytes(),
            )
          : Number.POSITIVE_INFINITY,
      ),
    );

    // Claim the job (nextJob reads don't remove — without this a second
    // slot could pick the same job concurrently).
    await this.storage.removeJob(job.url);
    try {
      this.lastDomain = new URL(job.url).hostname;
    } catch {
      // keep previous
    }

    let post: { job: CrawlJob; parsed: ParsedPage } | null = null;
    try {
      post = await this.crawlUrl(job, reservation);
    } catch (error) {
      // The job was claimed at dispatch — a mid-crawl crash must not
      // silently drop it: re-enqueue with the transient-failure backoff.
      this.stats.errors++;
      this.emit({ type: 'error', error });
      job.attempts++;
      if (job.attempts > MAX_TRANSIENT_RETRIES) {
        await this.storage.markCrawled(job.url, '', '', {
          status: 'failed',
          at: this.config.clock(),
        });
      } else {
        job.nextAttempt = this.config.clock() + retryBackoffMs(job.attempts);
        await this.storage.putJob(job);
      }
    } finally {
      this.scheduler.release(job.url); // notes completion → interval restarts
    }
    this.emitStats();

    // Post-crawl work (feed/sitemap discovery + link following) runs
    // OUTSIDE the slot hold — the slot is only held for the page request.
    // Discovery's own requests re-enter the scheduler per request.
    if (post && this.running) await this.postCrawl(post.job, post.parsed);
    return 0;
  }

  /**
   * Defer a politeness/budget-blocked job: nextAttempt = the computed
   * unblock time, so nextJob's ready-scan skips it until due and no slot
   * spins on it. (A job returned by nextJob was ready — deferral can only
   * postpone, never shorten a retry backoff.)
   */
  private async deferJob(job: CrawlJob, waitMs: number): Promise<number> {
    const wait = Math.max(250, Math.min(waitMs, 60_000));
    job.nextAttempt = this.config.clock() + wait;
    await this.storage.putJob(job);
    return wait;
  }

  /**
   * Run an internal request (feed / sitemap discovery) through the
   * per-domain scheduler lane — invariant (ii): discovery traffic counts
   * toward the domain's interval like any other request. Returns null when
   * the engine stopped while waiting for the lane.
   */
  private async throughScheduler<T>(url: string, fn: () => Promise<T>): Promise<T | null> {
    while (this.running) {
      if (this.scheduler.tryAcquire(url)) {
        try {
          return await fn();
        } finally {
          this.scheduler.release(url);
        }
      }
      await this.sleep(Math.max(250, this.scheduler.timeUntilNextRequest(url)));
    }
    return null;
  }

  /**
   * Crawl one job. The SSRF admission check runs FIRST — before robots.txt
   * or any other request is issued (the P0 ordering fix). Defense in depth:
   * net.ts refuses private targets too, but this check runs before the
   * robots fetch — ordering here is the actual fix.
   *
   * Returns the parsed page for post-crawl work (discovery, link
   * following), which the slot runner runs AFTER releasing the slot.
   */
  private async crawlUrl(
    job: CrawlJob,
    reservation?: ByteReservation,
  ): Promise<{ job: CrawlJob; parsed: ParsedPage } | null> {
    const now = this.config.clock();

    // 1. SSRF guard FIRST.
    if (!isPubliclyFetchable(job.url)) {
      await this.storage.removeJob(job.url);
      this.stats.skipped++;
      this.stats.ssrfBlocked++;
      return null;
    }

    // 2. Freshness gate: a crawled URL is only re-crawled once its recrawl
    // interval has elapsed. 'observed' entries (feed/sitemap) never block a
    // real fetch; 'failed' negatives recrawl after their interval too.
    const existing = await this.storage.getCrawled(job.url);
    if (
      existing &&
      existing.status === 'fetched' &&
      (existing.recrawlDue ?? Number.POSITIVE_INFINITY) > now
    ) {
      await this.storage.removeJob(job.url);
      this.stats.skipped++;
      return null;
    }

    // 3. robots.txt (through the choke point; fail-closed on private hosts).
    if (this.config.politeness.respectRobots) {
      const allowed = await this.robots.shouldCrawlUrl(job.url);
      if (!allowed) {
        await this.storage.removeJob(job.url);
        this.stats.skipped++;
        this.stats.robotsBlocked++;
        return null;
      }
    }

    // 4. Fetch — clamped to the byte reservation taken at dispatch (or to
    // the remaining hourly budget when called without one — internal/test
    // callers), so a single page can't blow the window.
    const byteBudget = this.config.budgets.maxBytesPerHour;
    const maxBytes =
      reservation?.bytes ??
      Math.min(
        this.config.budgets.maxPageSizeKB * 1024,
        byteBudget > 0 ? this.meter.remainingBytesThisHour(byteBudget) : Number.POSITIVE_INFINITY,
      );
    if (maxBytes < 16 * 1024) {
      if (reservation) this.meter.settleBytes(reservation);
      return null; // idle until the window opens
    }

    try {
      const outcome = await this.net.guardedFetchPage(job.url, { maxBytes });

      if (!outcome.ok) {
        await this.handleFetchFailure(job, outcome, now);
        return null;
      }

      const parsed = await this.handleFetchedPage(job, outcome, existing, now);
      return parsed ? { job, parsed } : null;
    } finally {
      // Settle the dispatch-time byte reservation whatever happened — the
      // actual stream bytes were already counted by net.ts via recordFetch.
      if (reservation) this.meter.settleBytes(reservation);
    }
  }

  private async handleFetchFailure(
    job: CrawlJob,
    outcome: Extract<FetchOutcome, { ok: false }>,
    now: number,
  ): Promise<void> {
    if (outcome.reason === 'ssrf' || outcome.reason === 'unsupported-scheme') {
      // Permanent refusal — the guard fired inside net.ts (e.g. redirect).
      await this.storage.removeJob(job.url);
      this.stats.skipped++;
      this.stats.ssrfBlocked++;
      return;
    }

    if (outcome.kind === 'permanent') {
      // Negative cache entry (F12 fix): 4xx / non-HTML / oversize are never
      // retried and never re-fetched on rediscovery.
      await this.storage.markCrawled(job.url, '', '', { status: 'failed', at: now });
      await this.storage.removeJob(job.url);
      this.stats.fetchFailed++;
      return;
    }

    // Transient: bounded retry — at most MAX_TRANSIENT_RETRIES re-attempts,
    // then the URL joins the negative cache (which itself expires after the
    // 7-day TTL, so even exhausted transients are retried eventually).
    this.stats.errors++;
    this.stats.fetchFailed++;
    job.attempts++;
    if (job.attempts > MAX_TRANSIENT_RETRIES) {
      await this.storage.markCrawled(job.url, '', '', { status: 'failed', at: now });
      await this.storage.removeJob(job.url);
    } else {
      // Bounded exponential backoff with jitter (30s→2m→8m, 10m cap, ±25%).
      // The job is re-queued with a future nextAttempt; nextJob skips it
      // until due, so a failing URL can never spin the crawl loop.
      job.nextAttempt = now + retryBackoffMs(job.attempts);
      await this.storage.putJob(job);
    }
  }

  private async handleFetchedPage(
    job: CrawlJob,
    outcome: Extract<FetchOutcome, { ok: true }>,
    existing: Awaited<ReturnType<CrawlerStorage['getCrawled']>>,
    now: number,
  ): Promise<ParsedPage | null> {
    // 5. Parse + hash + enrich (worker-pool boundary — off the main thread
    // when Web Workers are available; the enrich module rides along so the
    // whole per-page CPU lane stays off-thread).
    const { parsed, contentHash: localHash, enrichment } = await this.pool.processPage(
      outcome.body,
      job.url,
      { enrich: this.config.modules.enrich.enabled },
    );

    if (parsed.wordCount < 10) {
      await this.storage.removeJob(job.url);
      this.stats.skipped++;
      this.stats.thinContent++;
      return null;
    }

    // Duplicate-content check — but the page's OWN previous hash is not a
    // duplicate, it's an unchanged recrawl (freshness signal).
    const duplicate = await this.storage.findByHash(localHash);
    if (duplicate && duplicate !== job.url) {
      await this.storage.removeJob(job.url);
      this.stats.skipped++;
      this.stats.duplicates++;
      return null;
    }
    const changed = !existing || existing.contentHash !== localHash;

    // 6. Enrichment ran on the worker (optional module; deterministic — any
    // node produces the same tags for the same page). Off → the site's own
    // meta keywords.
    const topics = enrichment?.topics ?? parsed.keywords;

    // 7. Freshness bookkeeping + single storage txn per page.
    const freshness = nextFreshness(existing, changed, now);
    await this.storage.markCrawled(job.url, localHash, parsed.title, {
      status: 'fetched',
      at: now,
      topics,
      ...freshness,
    });
    await this.storage.removeJob(job.url);
    // Schedule the recrawl (low priority; the scheduler holds it until due).
    await this.storage.putJob({
      url: job.url,
      priority: 0.3,
      depth: job.depth,
      attempts: 0,
      followLinks: job.followLinks,
      shard: job.shard ?? urlShard(job.url),
      nextAttempt: freshness.recrawlDue,
    });

    this.stats.pagesIndexed++;
    this.meter.recordPage();
    this.stats.bandwidthUsed = this.meter.getSessionTotals().bytes;
    if (outcome.viaProxy) this.stats.viaProxy++;
    else this.stats.viaDirect++;
    this.stats.queueSize = await this.storage.queueSize();

    // 8. Publish the SIP-01 observation (kind 39697) — FIRE-AND-TRACK: the
    // crawl pipeline never awaits relay fan-out (blueprint §3.1 "publish
    // off the critical path"). If the page claims a canonical URL, the
    // observation is filed under THAT identity.
    this.trackPublish(
      this.publishObservation(job.url, parsed, topics, enrichment?.docType),
    );

    return parsed;
  }

  /**
   * The publish lane: sign + fan-out run async, tracked so failures surface
   * as 'error' events (never unhandled rejections) and stop() can drain
   * with a grace period. A hanging relay can't stall the pipeline; zero-ack
   * events land in the IDB outbox inside the publisher as before, and the
   * per-relay health gate is unchanged.
   */
  private trackPublish(promise: Promise<void>): void {
    this.publishLane.add(promise);
    void promise
      .catch((error) => {
        this.stats.errors++;
        this.emit({ type: 'error', error });
      })
      .finally(() => this.publishLane.delete(promise));
  }

  /**
   * Post-crawl work — runs OUTSIDE the slot hold (the fetch slot was
   * released after the page request): feed/sitemap discovery (whose own
   * requests re-enter the scheduler per request) and link following.
   */
  private async postCrawl(job: CrawlJob, parsed: ParsedPage): Promise<void> {
    // 9. Discovery modules (feeds + sitemaps) — config-gated.
    await this.runDiscovery(job, parsed);

    // 10. Link following — self-expanding index. The page's whole link set
    // is admitted in ONE batched transaction (P3 IDB discipline), not
    // per-link puts.
    if (job.followLinks !== false && job.depth < this.config.crawl.maxDepth) {
      const maxLinks = this.config.crawl.ecoMode ? 5 : 10;
      const links = parsed.links
        .slice(0, maxLinks)
        .filter((link) => link !== job.url && this.discoveryGuard.allow(link));
      if (links.length > 0) {
        const result = await this.admitMany(links, {
          priority: job.priority * 0.8,
          depth: job.depth + 1,
          discoveredFrom: job.url,
          applyTraps: true,
        });
        if (result.queued > 0) {
          this.stats.discovered += result.queued;
          this.stats.queueSize = await this.storage.queueSize();
          if (this.config.modules.sharding.enabled) {
            this.stats.homeShardJobs = await this.storage.queueShardCount(this.homeShard);
          }
        }
      }
    }
  }

  /** Build → sign → publish one observation; outbox on zero acks. */
  private async publishObservation(
    pageUrl: string,
    parsed: ParsedPage,
    topics: string[],
    docType?: string,
  ): Promise<void> {
    const indexUrl = parsed.canonical
      ? (normalizeIndexUrl(parsed.canonical) ?? pageUrl)
      : pageUrl;
    const host = new URL(indexUrl).hostname;
    const platform = detectPlatform(host);
    const result = await this.publisher.publishIndexObservation({
      url: indexUrl,
      title: parsed.title,
      description: parsed.description,
      image: parsed.image,
      language: parsed.language,
      published: parsed.published,
      source: this.config.source,
      // Extension registry (spec §9.2): a browser crawler only ever sees clearnet.
      network: 'clearnet',
      ...(platform ? { platform } : {}),
      type:
        platform === 'github' || platform === 'gitlab'
          ? 'repository'
          : (docType ?? 'page'),
      tags: topics,
    });
    if (result) {
      // stats.published counts only relay-ACKED events.
      if (result.delivered > 0) this.stats.published++;
      this.stats.outboxPending = await this.storage.outboxSize();
      this.emit({ type: 'observation', url: result.normalizedUrl, delivered: result.delivered });
      this.emitStats();
    }
  }

  /** Feeds + sitemaps (discovery module, config-gated). */
  private async runDiscovery(job: CrawlJob, parsed: ParsedPage): Promise<void> {
    const { feeds, sitemaps } = this.config.modules.discovery;

    if (feeds && parsed.feeds.length > 0) {
      for (const feed of parsed.feeds.slice(0, 2)) {
        if (this.followedFeeds.has(feed.url)) continue;
        this.followedFeeds.add(feed.url);
        // Feed fetches count toward the domain's interval (invariant ii).
        const followed = await this.throughScheduler(feed.url, () =>
          this.discovery.followFeed(feed.url),
        );
        if (!followed) continue;
        this.stats.feedsFound++;
        let discovered = 0;
        for (const entry of followed.entries) {
          const normalized = normalizeIndexUrl(entry.url);
          if (!normalized) continue;
          if (await this.storage.getCrawled(normalized)) continue;

          // Index the entry directly — the feed is the site's own summary.
          // Mark as 'observed', NOT 'fetched': the queued real fetch below
          // must not be skipped (observed ≠ fetched).
          if (entry.title && entry.title !== normalized) {
            await this.storage.markCrawled(
              normalized,
              await hashContent(entry.title),
              entry.title,
              { status: 'observed', at: this.config.clock() },
            );
            this.trackPublish(
              this.publishObservation(normalized, {
                ...parsed,
                title: entry.title,
                description: entry.summary ?? '',
                published: entry.published,
                canonical: '',
              }, [], 'article'),
            );
            this.stats.pagesIndexed++;
          }

          const result = await this.admit(normalized, {
            priority: job.priority * 0.6,
            depth: job.depth + 1,
            discoveredFrom: feed.url,
            applyTraps: true,
          });
          if (result === 'queued') discovered++;
        }
        this.stats.discovered += discovered;
        this.stats.queueSize = await this.storage.queueSize();
      }
    }

    if (sitemaps) {
      try {
        const origin = new URL(job.url).origin;
        if (!this.probedSitemaps.has(origin)) {
          this.probedSitemaps.add(origin);
          // Sitemap probes count toward the domain's interval (invariant ii).
          const urls =
            (await this.throughScheduler(origin, () =>
              this.discovery.probeSitemaps(origin),
            )) ?? [];
          if (urls.length > 0) this.stats.sitemapsFound++;
          let added = 0;
          for (const url of urls) {
            // Only skip URLs we ACTUALLY fetched — observed ones still get
            // a real fetch.
            if (await this.storage.isFetched(url)) continue;
            const result = await this.admit(url, {
              priority: job.priority * 0.5,
              depth: job.depth + 1,
              discoveredFrom: origin,
              applyTraps: true,
            });
            if (result === 'queued') added++;
          }
          if (added > 0) {
            this.stats.discovered += added;
            this.stats.queueSize = await this.storage.queueSize();
          }
        }
      } catch {
        // Discovery is best-effort.
      }
    }
  }

  /**
   * Abortable + wakeable sleep: resolves early when the node stops (abort)
   * or when new work is admitted (wake) — politeness-blocked/idle slots
   * don't poll, they sleep until the computed unblock time OR new work
   * arrives.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.wakeListeners.delete(done);
        this.abortController?.signal.removeEventListener('abort', done);
        resolve();
      };
      const timeout = setTimeout(done, ms);
      this.wakeListeners.add(done);
      this.abortController?.signal.addEventListener('abort', done);
    });
  }

  /** Wake sleeping slot runners (new work admitted / outbox activity). */
  private wake(): void {
    for (const listener of [...this.wakeListeners]) listener();
  }
}
