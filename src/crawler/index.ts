/**
 * @sip01/crawler-core — the ONE deep module both crawler apps share.
 *
 * The entire public surface is this file: `createCrawler(config)` plus
 * types. Queue scheduling, robots caching, SSRF enforcement, retry policy,
 * worker pooling, outbox flushing are all INTERNAL — apps cannot import
 * `@sip01/crawler-core/internal/*` (enforced by package.json `exports`),
 * so the P0 ordering bug class (robots fetched before the SSRF check, a
 * private URL entering the queue) is unrepresentable from the outside.
 *
 * Host-injected seams (no React, no app imports, no direct nostr pool
 * creation in here):
 *   - signer:    NostrEvent template → signed event (the indexer identity,
 *                spec §14 — never the user's personal key)
 *   - transports.publish / subscribe/query: the host's relay pool
 *   - storage:   CrawlerStorage adapter (default: IndexedDB)
 *   - clock:     unix-ms clock (default Date.now)
 *   - fetch:     transport (default globalThis.fetch) — used ONLY through
 *                the guardedFetch choke point
 *
 * Optional modules (config-flagged):
 *   indexstr on: intake, enrich, traps, sharding, heartbeat
 *   crawlstr on: discovery (feeds+sitemaps), metering; traps both (default on)
 */

import type { NostrEvent } from '@nostrify/nostrify';
import { getIndexerIdentity } from '@sip01/protocol';

import { Engine, type CrawlerEvent } from './internal/engine';
import { Meter } from './internal/meter';
import { nodeShard } from './internal/sharding';
import { createIdbStorage, type CrawlerStorage } from './internal/storage';
import { RelayProbe, type RelayCapabilities } from './internal/modules/relayprobe';
import { Net } from './internal/net';
import type {
  CrawledRecord,
  CrawlerStats,
  PersistedStats,
  ResolvedConfig,
} from './internal/types';
import type { ParsedHeartbeat } from './internal/heartbeat';

export type { CrawlerStats, CrawlJob, CrawledRecord, PersistedStats } from './internal/types';
export type { CrawlerEvent } from './internal/engine';
export type { RelayHealth } from './internal/publisher';
export type { RelayCapabilities } from './internal/modules/relayprobe';

// Heartbeat READ seam: the wire shape of kind 16919 is owned here, so apps
// rendering a network view never mirror the parsing logic locally.
// (Heartbeat PUBLISHING is the engine's side channel; these are the pure
// reader helpers plus the node.networkHeartbeats() query path below.)
export {
  parseHeartbeat,
  dedupeHeartbeats,
  isNodeLive,
  coarsenCount,
  HEARTBEAT_KIND,
  HEARTBEAT_TTL_S,
} from './internal/heartbeat';
export type { ParsedHeartbeat } from './internal/heartbeat';

/** NostrEvent template the host signer must complete (kind/created_at/
 *  tags/content in; id/pubkey/sig out). */
export interface SignableEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface CrawlerConfig {
  /** IndexedDB database name ('crawlstr-crawler' | 'indexstr-crawler'). */
  dbName: string;
  /** Indexer software id for the `source` tag ('crawlstr/v2' | 'indexstr/v2', ≤100 chars). */
  source: string;
  /** Node protocol version for the kind 16919 heartbeat `v` tag/payload —
   *  the software's major version ('2' for v2 nodes). Defaults to '1'. */
  nodeVersion?: string;
  /** Host-injected signer (NostrEvent template → signed event). Defaults to
   *  the device's dedicated indexer identity from @sip01/protocol when
   *  available in the host environment. */
  signer?: (event: SignableEvent) => Promise<NostrEvent>;
  /** Indexer identity (hex pubkey / npub). Defaults: derived from the
   *  protocol package's device identity. */
  indexerPubkey?: string;
  indexerNpub?: string;
  transports: {
    /** Publish one signed event to one relay. MUST throw on failure. */
    publish: (relayUrl: string, ev: NostrEvent) => Promise<void>;
    /** Subscribe to a filter (intake); returns an unsubscribe fn. */
    subscribe?: (filter: object, onEvent: (ev: NostrEvent) => void) => () => void;
    /** Query recent kind 39697 events (network intake polling). */
    query?: (since: number, limit: number) => Promise<NostrEvent[]>;
    /** Query raw filters against the host's read pool. Powers
     *  node.networkHeartbeats() (kind 16919 network view). Optional —
     *  without it networkHeartbeats() returns []. */
    heartbeatQuery?: (filters: Array<Record<string, unknown>>) => Promise<NostrEvent[]>;
    /** CORS proxy template with a '{href}' placeholder. */
    proxyTemplate?: string;
    /** Injectable fetch (tests). Default: globalThis.fetch. */
    fetch?: typeof fetch;
  };
  /** Publish relay set. Conformance: ≥2 relays, ≥1 SIP-01-aware index relay. */
  relays: { publish: string[] };
  budgets?: {
    maxPagesPerHour?: number; // default 100; 0 = unlimited
    maxBytesPerHour?: number; // default 250 MB; 0 = unlimited
    maxPageSizeKB?: number; // default 2048
  };
  politeness?: {
    parallelism?: number; // default 4, max 8 (P3 parallel slot scheduler)
    minIntervalPerDomainMs?: number; // default 5000 (8000 eco)
    maxCrawlDelayMs?: number; // default 60_000 (cap)
    respectRobots?: boolean; // default true
  };
  modules?: {
    intake?: { enabled: boolean; intervalMs?: number };
    enrich?: { enabled: boolean };
    discovery?: { feeds?: boolean; sitemaps?: boolean };
    heartbeat?: { enabled?: boolean; intervalMs?: number }; // default 10 min
    traps?: { enabled?: boolean }; // default true
    sharding?: { enabled?: boolean };
  };
  crawl?: {
    maxDepth?: number; // default 3
    ecoMode?: boolean; // default true
    maxQueueSize?: number; // default 150_000
  };
  /** Parse/hash/enrich Web Workers (linkedom). Default:
   *  min(4, hardwareConcurrency-1). Worker-less environments (Node, tests)
   *  automatically fall back to inline main-thread processing. */
  workerCount?: number;
  /** Storage adapter (default: IndexedDB under config.dbName). */
  storage?: CrawlerStorage;
  /** Injected clock (unix ms) for testability. Default: Date.now. */
  clock?: () => number;
}

export interface CrawlerNode {
  /** Flush the outbox, start heartbeat/intake side channels + scheduler. */
  start(): Promise<void>;
  /** Abort-safe stop; queue and outbox persist. */
  stop(): Promise<void>;
  /** Seed URLs through the admission path. Manual seeds self-expand
   *  (followLinks default true); curated collections pass
   *  `followLinks: false` — the collection IS the crawl plan. */
  seed(
    urls: string[],
    opts?: { priority?: number; followLinks?: boolean },
  ): Promise<{ admitted: number; rejected: number }>;
  /** Synchronous stats snapshot (session-scoped until start() rehydrates
   *  the persisted counts). */
  stats(): CrawlerStats;
  /** Persisted store counts, readable before start() — the pre-start
   *  dashboard display. */
  persistedStats(): Promise<PersistedStats>;
  /** Recently crawled pages, newest first (History tab). Real fetches
   *  only by default; opts widen to observed/failed rows. */
  recentCrawls(
    limit?: number,
    opts?: { includeObserved?: boolean; includeFailed?: boolean },
  ): Promise<CrawledRecord[]>;
  /** Clear the crawl queue (crawled history and the outbox are kept). */
  clearQueue(): Promise<void>;
  /** Wipe ALL local state: queue + crawled history (incl. negative cache)
   *  + outbox. The explicit user "reset everything" action. */
  clearAll(): Promise<void>;
  /** Recent network node heartbeats (kind 16919), deduped latest-per-node,
   *  newest first. Requires transports.heartbeatQuery; [] without it. */
  networkHeartbeats(): Promise<ParsedHeartbeat[]>;
  /** Subscribe to node events; returns an unsubscribe function. */
  on(
    event: 'stats' | 'observation' | 'error',
    cb: (payload: CrawlerEvent) => void,
  ): () => void;
  outboxSize(): Promise<number>;
  flushOutbox(): Promise<number>;
  relayHealth(): Record<string, import('./internal/publisher').RelayHealth>;
  indexerInfo(): { pubkeyHex: string; npub: string; homeShard: number };
  /** Probe a relay's NIP-11 document through the guarded choke point
   *  (relayprobe module, UI-triggered). */
  probeRelay(url: string): Promise<RelayCapabilities>;
  /** True while the crawl loop is running. */
  isRunning(): boolean;
}

export function createCrawler(config: CrawlerConfig): CrawlerNode {
  // Identity: host-injected, else the protocol package's device identity.
  let pubkey = config.indexerPubkey ?? '';
  let npub = config.indexerNpub ?? '';
  let signer = config.signer;
  if (!signer || !pubkey) {
    const identity = getIndexerIdentity();
    pubkey = pubkey || identity.pubkeyHex;
    npub = npub || identity.npub;
    if (!signer) {
      signer = async (event) => {
        const { finalizeEvent } = await import('nostr-tools/pure');
        const { getIndexerSecretKey } = await import('@sip01/protocol');
        return finalizeEvent(event, getIndexerSecretKey()) as NostrEvent;
      };
    }
  }

  const resolved: ResolvedConfig = {
    dbName: config.dbName,
    source: config.source,
    nodeVersion: config.nodeVersion ?? '1',
    signer,
    indexerPubkey: pubkey,
    indexerNpub: npub,
    publish: config.transports.publish,
    intakeQuery: config.transports.query,
    heartbeatQuery: config.transports.heartbeatQuery,
    proxyTemplate: config.transports.proxyTemplate,
    fetchFn: config.transports.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)),
    clock: config.clock ?? Date.now,
    relays: { publish: config.relays.publish },
    budgets: {
      maxPagesPerHour: config.budgets?.maxPagesPerHour ?? 100,
      maxBytesPerHour: config.budgets?.maxBytesPerHour ?? 250 * 1024 * 1024,
      maxPageSizeKB: config.budgets?.maxPageSizeKB ?? 2048,
    },
    politeness: {
      parallelism: Math.max(1, Math.min(8, config.politeness?.parallelism ?? 4)),
      minIntervalPerDomainMs: config.politeness?.minIntervalPerDomainMs ?? 5000,
      maxCrawlDelayMs: config.politeness?.maxCrawlDelayMs ?? 60_000,
      respectRobots: config.politeness?.respectRobots ?? true,
    },
    modules: {
      intake: {
        enabled: config.modules?.intake?.enabled ?? false,
        intervalMs: config.modules?.intake?.intervalMs ?? 120_000,
      },
      enrich: { enabled: config.modules?.enrich?.enabled ?? false },
      discovery: {
        feeds: config.modules?.discovery?.feeds ?? false,
        sitemaps: config.modules?.discovery?.sitemaps ?? false,
      },
      heartbeat: {
        enabled: config.modules?.heartbeat?.enabled ?? false,
        intervalMs: config.modules?.heartbeat?.intervalMs ?? 600_000,
      },
      traps: { enabled: config.modules?.traps?.enabled ?? true },
      sharding: { enabled: config.modules?.sharding?.enabled ?? false },
    },
    crawl: {
      maxDepth: config.crawl?.maxDepth ?? 3,
      ecoMode: config.crawl?.ecoMode ?? true,
      maxQueueSize: config.crawl?.maxQueueSize ?? 150_000,
    },
    workerCount:
      config.workerCount ??
      Math.max(
        2,
        Math.min(
          4,
          (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 5 : 5) - 1,
        ),
      ),
  };

  // ONE meter per node, shared with the relay-probe lane: the contract is
  // "counts EVERY byte" — pages, robots, feeds, sitemaps AND NIP-11 probes.
  const meter = new Meter(resolved.clock);
  resolved.meter = meter;

  const storage = config.storage ?? createIdbStorage(config.dbName);
  const engine = new Engine(resolved, storage);
  const probeNet = new Net({
    fetchFn: resolved.fetchFn,
    proxyTemplate: resolved.proxyTemplate,
    meter,
  });
  const probe = new RelayProbe(probeNet, resolved.clock);

  return {
    start: () => engine.start(),
    stop: () => engine.stop(),
    seed: (urls, opts) => engine.seed(urls, opts),
    stats: () => engine.getStats(),
    persistedStats: () => engine.persistedStats(),
    recentCrawls: (limit, opts) => engine.recentCrawls(limit, opts),
    clearQueue: () => engine.clearQueue(),
    clearAll: () => engine.clearAll(),
    networkHeartbeats: () => engine.networkHeartbeats(),
    on: (_event, cb) => engine.on(cb),
    outboxSize: () => storage.outboxSize(),
    flushOutbox: () => engine.flushOutbox(),
    relayHealth: () => engine.relayHealth(),
    indexerInfo: () => ({ pubkeyHex: pubkey, npub, homeShard: nodeShard(pubkey) }),
    probeRelay: (url) => probe.probeRelay(url),
    isRunning: () => engine.isRunning(),
  };
}
