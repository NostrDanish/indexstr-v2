// Shared internal type definitions for @sip01/crawler-core.
//
// Union of both v1 apps' crawler types (crawlstr + indexstr). Nothing here
// is part of the public API — the public surface lives in src/index.ts.

import type { NostrEvent } from '@nostrify/nostrify';
import type { Meter } from './meter';

export interface CrawlJob {
  url: string;
  priority: number;
  depth: number;
  discoveredFrom?: string;
  attempts: number;
  lastAttempt?: number;
  nextAttempt?: number;
  /**
   * Set to false to index only this exact URL without following its links.
   * Curated collections / network-intake URLs use this.
   */
  followLinks?: boolean;
  /**
   * Deterministic crawl-space shard (0–255, see sharding.ts). Assigned at
   * enqueue time; the scheduler prefers the node's home shard when the
   * sharding module is enabled.
   */
  shard?: number;
}

/** A discovered feed link (rel=alternate with an RSS/Atom/XML type). */
export interface FeedLink {
  url: string;
  /** 'rss' | 'atom' — whatever the link tag claimed. */
  kind: string;
}

export interface ParsedPage {
  title: string;
  description: string;
  /** Representative image (og:image / twitter:image), resolved to absolute. */
  image?: string;
  /**
   * Claimed publication time, unix seconds (SIP-01 `published` tag).
   * Non-positive (pre-1970) claims are dropped at parse time — SIP-01
   * finding C-1: relays reject a negative `published` wholesale.
   */
  published?: number;
  /** RSS/Atom feeds linked from the page (discovery signal). */
  feeds: FeedLink[];
  /** Canonical URL the page claims for itself ('' when absent). */
  canonical: string;
  /** meta keywords, split/trimmed/filtered (source evidence for enrich). */
  keywords: string[];
  text: string;
  language: string;
  links: string[];
  wordCount: number;
  /** og:type, lowercased (article, website, video.other, …). */
  ogType?: string;
  /** JSON-LD @type values found on the page. */
  jsonLdTypes: string[];
  /** First few h1/h2 headings — classification evidence. */
  headings: string[];
}

/**
 * A crawled-page record with freshness bookkeeping and a status field.
 *
 *   'fetched'  — we downloaded and parsed the page.
 *   'observed' — we only saw it referenced (RSS/Atom feed, sitemap) and
 *                published an observation, but never fetched the page.
 *                observed ≠ fetched: a feed can announce a page that 404s
 *                when actually fetched, so observed entries never block a
 *                future real fetch.
 *   'failed'   — negative cache entry (permanent failure: 4xx, non-HTML,
 *                oversize, robots, SSRF). Prevents duplicate re-fetch loops.
 */
export interface CrawledRecord {
  url: string;
  contentHash: string;
  title: string;
  crawledAt: number;
  status: 'fetched' | 'observed' | 'failed';
  /** Derived topics at last crawl. */
  topics?: string[];
  /** Unix ms — when the content hash last CHANGED. */
  lastChangedAt?: number;
  /** How often recrawls found changed content. */
  changeCount?: number;
  /** Consecutive recrawls with unchanged content. */
  unchangedStreak?: number;
  /** Unix ms — when this URL becomes eligible for recrawl. */
  recrawlDue?: number;
}

export interface CrawlerStats {
  pagesIndexed: number;
  queueSize: number;
  /** Session bytes, counted at the guardedFetch choke point (all traffic). */
  bandwidthUsed: number;
  uptime: number;
  errors: number;
  skipped: number;
  viaProxy: number;
  viaDirect: number;
  robotsBlocked: number;
  /** Refused before any request: private/loopback/link-local target (SSRF). */
  ssrfBlocked: number;
  fetchFailed: number;
  duplicates: number;
  thinContent: number;
  /** Observations accepted by at least one relay (this session). */
  published: number;
  outboxPending: number;
  /** New URLs discovered from pages/feeds/sitemaps (this session). */
  discovered: number;
  feedsFound: number;
  sitemapsFound: number;
  homeShardJobs: number;
  networkIntake: number;
  intakeRejected: number;
  trapsBlocked: number;
}

/**
 * Persisted store counts, readable BEFORE the node is started (stats() is
 * session-scoped until start() rehydrates it) — the pre-start dashboard
 * display. Once the node runs, 'stats' events supersede this.
 */
export interface PersistedStats {
  queueSize: number;
  pagesIndexed: number;
  outboxPending: number;
  /** Queued jobs in the node's home shard (0 when sharding is off). */
  homeShardJobs: number;
}

export function emptyStats(): CrawlerStats {
  return {
    pagesIndexed: 0,
    queueSize: 0,
    bandwidthUsed: 0,
    uptime: 0,
    errors: 0,
    skipped: 0,
    viaProxy: 0,
    viaDirect: 0,
    robotsBlocked: 0,
    ssrfBlocked: 0,
    fetchFailed: 0,
    duplicates: 0,
    thinContent: 0,
    published: 0,
    outboxPending: 0,
    discovered: 0,
    feedsFound: 0,
    sitemapsFound: 0,
    homeShardJobs: 0,
    networkIntake: 0,
    intakeRejected: 0,
    trapsBlocked: 0,
  };
}

/** The resolved (defaults-applied) configuration the engine runs on. */
export interface ResolvedConfig {
  dbName: string;
  source: string; // 'crawlstr/v2' | 'indexstr/v2'
  nodeVersion: string; // heartbeat `v` tag/payload — software major version
  signer: (event: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }) => Promise<NostrEvent>;
  indexerPubkey: string;
  indexerNpub: string;
  publish: (relayUrl: string, ev: NostrEvent) => Promise<void>;
  intakeQuery?: (since: number, limit: number) => Promise<NostrEvent[]>;
  heartbeatQuery?: (
    filters: Array<Record<string, unknown>>,
  ) => Promise<NostrEvent[]>;
  proxyTemplate?: string;
  fetchFn: typeof fetch;
  clock: () => number;
  /** Shared byte meter (the host's probe lane feeds it too — the meter
   *  contract is "counts EVERY byte", relay probes included). */
  meter?: Meter;
  relays: { publish: string[] };
  budgets: {
    maxPagesPerHour: number;
    maxBytesPerHour: number;
    maxPageSizeKB: number;
  };
  politeness: {
    parallelism: number;
    minIntervalPerDomainMs: number;
    maxCrawlDelayMs: number;
    respectRobots: boolean;
  };
  modules: {
    intake: { enabled: boolean; intervalMs: number };
    enrich: { enabled: boolean };
    discovery: { feeds: boolean; sitemaps: boolean };
    heartbeat: { enabled: boolean; intervalMs: number };
    traps: { enabled: boolean };
    sharding: { enabled: boolean };
  };
  crawl: {
    maxDepth: number;
    ecoMode: boolean;
    maxQueueSize: number;
  };
  /** Parse/hash/enrich worker count (default min(4, hardwareConcurrency-1)).
   *  In worker-less environments the pool falls back to inline processing. */
  workerCount: number;
}
