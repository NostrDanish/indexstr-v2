/**
 * useCrawler — the thin React adapter over @sip01/crawler-core (v2).
 *
 * The whole crawler (engine, queue, guarded fetch, robots, scheduler,
 * publisher, outbox, heartbeat, sharding, intake, enrich, traps, freshness)
 * lives in the shared core behind `createCrawler()`. This hook only:
 *
 *   1. builds the indexstr NETWORK NODE config — sharding + heartbeat
 *      (kind 16919) + network intake + enrich + traps all ON (blueprint §6);
 *   2. injects the host seams: signer (dedicated indexer identity from
 *      @sip01/protocol, spec §14 — never the user's key), publish/query
 *      transports over the app's nostrify pool, the app's CORS-proxy-aware
 *      fetch wire + proxy template (core owns the SSRF guard, the app owns
 *      the wire), IndexedDB storage by default, default clock;
 *   3. maps node events onto React state and exposes the v1 hook surface
 *      (start/stop/seedUrl/seedCollection/clearAll/settings/…) so the
 *      dashboard is unchanged;
 *   4. applies the host-side crawl constraints (WiFi-only / charging-only /
 *      battery / slow network) as start/stop intent — a host policy the
 *      core deliberately does not own.
 *
 * Admission gating note (P0 follow-up): v1's `seedCollection` enqueued
 * WITHOUT the SSRF/trap admission check. In v2 every enqueue source —
 * seeds, collections, discovered links, network intake — funnels through
 * core's `admit()` (normalize → SSRF guard → traps → dedup → queue cap),
 * so the hole is closed by construction, not by app code.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useNostr } from '@nostrify/react';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { finalizeEvent } from 'nostr-tools/pure';
import {
  createCrawler,
  type CrawledRecord,
  type CrawlerNode,
  type CrawlerStats,
  type RelayCapabilities,
  type RelayHealth,
  type SignableEvent,
} from '@sip01/crawler-core';
import { WEB_INDEX_KIND, getIndexerSecretKey } from '@sip01/protocol';
import { getIndexPublishRelays, getIndexReadRelays } from '@/lib/indexRelays';
import {
  loadCrawlerSettings,
  saveCrawlerSettings,
  type CrawlerSettings,
} from '@/lib/crawlerSettings';
import {
  checkCrawlConstraints,
  getNodeCapabilities,
  type NodeCapabilities,
} from '@/lib/nodeCapabilities';

/**
 * IndexedDB database name — kept from v1 ('indexstr-crawler') so existing
 * crawl history, queue and outbox survive the v2 migration. Core owns the
 * database end to end (schema + all writes + the dashboard reads via
 * node.persistedStats()/recentCrawls()); the app never opens it directly.
 */
const CRAWLER_DB_NAME = 'indexstr-crawler';

/** Indexer software id for the SIP-01 `source` tag. */
const CRAWLER_SOURCE = 'indexstr/v2';

/** The app's CORS proxy — core templates the (already SSRF-vetted) target. */
const CORS_PROXY_TEMPLATE = 'https://proxy.shakespeare.diy/?url={href}';

/** How often the adapter re-checks host crawl constraints while running. */
const CONSTRAINT_CHECK_INTERVAL_MS = 15_000;

/** Human label for a shard, e.g. 167 → "A7" (same encoding as the wire tag). */
function shardLabel(shard: number): string {
  return shard.toString(16).toUpperCase().padStart(2, '0');
}

const ZERO_STATS: CrawlerStats = {
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

export function useCrawler() {
  const { nostr } = useNostr();
  // Transports capture this ref so a re-created nostr pool (relay metadata
  // loads, login) takes effect without rebuilding the node. Written in an
  // effect (never during render).
  const nostrRef = useRef(nostr);
  useEffect(() => {
    nostrRef.current = nostr;
  }, [nostr]);

  const nodeRef = useRef<CrawlerNode | null>(null);
  const [settings, setSettings] = useState<CrawlerSettings>(() => loadCrawlerSettings());
  const settingsRef = useRef<CrawlerSettings>(settings);
  const [wantsRunning, setWantsRunning] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [stats, setStats] = useState<CrawlerStats>(ZERO_STATS);
  const [recentCrawls, setRecentCrawls] = useState<CrawledRecord[]>([]);
  const [indexerInfo, setIndexerInfo] = useState<{ pubkeyHex: string; npub: string } | null>(null);
  const [homeShard, setHomeShard] = useState<number | null>(null);
  const [capabilities, setCapabilities] = useState<NodeCapabilities | null>(null);

  /** Build a crawler node for the given settings (full network-node config). */
  const buildNode = useCallback((s: CrawlerSettings): CrawlerNode => {
    return createCrawler({
      dbName: CRAWLER_DB_NAME,
      source: CRAWLER_SOURCE,

      // Host seam: dedicated per-device indexer identity (spec §14), via the
      // shared protocol package. Never the user's personal key.
      signer: async (event: SignableEvent): Promise<NostrEvent> =>
        finalizeEvent(event, getIndexerSecretKey()) as NostrEvent,

      transports: {
        // Host seam: publish over the app's existing nostrify pool, one
        // targeted connection per relay. MUST throw on failure — the core
        // publisher tracks per-relay health and outboxes zero-ack events.
        publish: async (relayUrl, event) => {
          await nostrRef.current
            .relay(relayUrl)
            .event(event, { signal: AbortSignal.timeout(10_000) });
        },
        // Network intake transport: recent SIP-01 observations from the
        // index relay pool become candidate crawl work (other indexers'
        // findings are this node's discovery feed).
        query: (since, limit) =>
          nostrRef.current.group(getIndexReadRelays()).query(
            [{ kinds: [WEB_INDEX_KIND], since, limit }],
            { signal: AbortSignal.timeout(15_000) },
          ),
        // Heartbeat read transport: kind 16919 queries over the index read
        // pool — powers core's networkHeartbeats() network view.
        heartbeatQuery: (filters) =>
          nostrRef.current.group(getIndexReadRelays()).query(
            filters as NostrFilter[],
            { signal: AbortSignal.timeout(15_000) },
          ),
        // Host seam: the app owns the wire — CORS-proxy-aware fetch. Core
        // owns the SSRF guard and applies it to the target BEFORE the proxy
        // template is ever expanded.
        fetch: (input, init) => globalThis.fetch(input, init),
        proxyTemplate: CORS_PROXY_TEMPLATE,
      },

      // App relay policy (lib/indexRelays.ts): SIP-01 index relays + NIP-50
      // pool + propagation relays + user customs. Snapshot at construction.
      relays: { publish: getIndexPublishRelays() },

      budgets: {
        maxPagesPerHour: s.maxPagesPerHour,
        maxBytesPerHour: s.maxBandwidthMB * 1024 * 1024,
        maxPageSizeKB: s.maxPageSizeKB,
      },
      politeness: {
        parallelism: s.maxConcurrent,
        minIntervalPerDomainMs: s.ecoMode ? 8000 : 5000,
        respectRobots: s.respectRobots,
      },
      crawl: {
        maxDepth: s.maxDepth,
        ecoMode: s.ecoMode,
      },
      modules: {
        // Indexstr = FULL network node (blueprint §6): everything on.
        // Discovery (feeds/sitemaps) opted in per blueprint P4 — cheap,
        // structured discovery alongside intake (settings-toggleable).
        discovery: { feeds: s.followFeeds, sitemaps: s.followSitemaps },
        intake: { enabled: true },
        enrich: { enabled: true },
        traps: { enabled: true },
        sharding: { enabled: true },
        heartbeat: { enabled: true }, // kind 16919, 10-minute cadence
      },
      // storage: default IndexedDB under dbName; clock: default Date.now.
    });
  }, []);

  /** (Re)create the node and wire its events into React state. */
  const wireNode = useCallback(
    (s: CrawlerSettings): CrawlerNode => {
      const node = buildNode(s);
      node.on('stats', (event) => {
        if (event.type === 'stats') setStats({ ...event.stats });
      });
      nodeRef.current = node;

      const info = node.indexerInfo();
      setIndexerInfo({ pubkeyHex: info.pubkeyHex, npub: info.npub });
      setHomeShard(info.homeShard);

      // Pre-start display: persisted queue/index/outbox counts (v1 init()
      // parity). Once the node starts, core stats events supersede these.
      node
        .persistedStats()
        .then((counts) => setStats((prev) => ({ ...prev, ...counts })))
        .catch(() => {
          // IndexedDB unavailable (jsdom, some private modes) — zeros.
        });

      return node;
    },
    [buildNode],
  );

  // Initialize the node (once).
  useEffect(() => {
    const node = wireNode(settingsRef.current);
    void getNodeCapabilities().then(setCapabilities).catch(() => {});
    setInitialized(true);
    return () => {
      nodeRef.current = null;
      void node.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Host constraint reconciler: WiFi-only / charging-only / battery / slow
  // network pause the node while keeping the user's "running" intent (v1's
  // engine stayed "running" but idle inside canCrawl(); same UX here).
  useEffect(() => {
    if (!wantsRunning || !initialized) return;
    let cancelled = false;

    const reconcile = async () => {
      const node = nodeRef.current;
      if (!node) return;
      const verdict = await checkCrawlConstraints(settingsRef.current);
      if (cancelled || nodeRef.current !== node) return;
      if (verdict.ok && !node.isRunning()) {
        await node.start();
      } else if (!verdict.ok && node.isRunning()) {
        await node.stop();
      }
    };

    void reconcile();
    const timer = setInterval(() => void reconcile(), CONSTRAINT_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [wantsRunning, initialized]);

  // Poll recent crawls for the History tab (core owns the DB read).
  useEffect(() => {
    if (!initialized) return;

    const loadRecent = async () => {
      try {
        // Fetched-only (the default): negative-cache and feed-observation
        // rows are not History material.
        setRecentCrawls(await nodeRef.current?.recentCrawls(20) ?? []);
      } catch {
        // IndexedDB unavailable — History stays empty.
      }
    };

    void loadRecent();
    const interval = setInterval(() => void loadRecent(), 10_000);
    return () => clearInterval(interval);
  }, [initialized]);

  const start = useCallback(async () => {
    setWantsRunning(true);
    // The reconciler effect starts the node once constraints pass; kick it
    // immediately so the button feels instant.
    const node = nodeRef.current;
    if (node && !node.isRunning()) {
      const verdict = await checkCrawlConstraints(settingsRef.current);
      if (verdict.ok) await node.start();
    }
  }, []);

  const stop = useCallback(async () => {
    setWantsRunning(false);
    const node = nodeRef.current;
    if (node) await node.stop();
  }, []);

  const seedUrl = useCallback(async (url: string) => {
    await nodeRef.current?.seed([url], { priority: 1.0 });
  }, []);

  /**
   * Seed a curated collection through the core's admission path. Chunked so
   * the UI gets progress; core's admit() dedups against already-crawled
   * (incl. negative cache) and enforces the queue cap. Returns jobs added.
   */
  const seedCollection = useCallback(
    async (urls: string[], onProgress?: (done: number, total: number) => void): Promise<number> => {
      const node = nodeRef.current;
      if (!node) return 0;
      let admitted = 0;
      const CHUNK = 2000;
      for (let i = 0; i < urls.length; i += CHUNK) {
        // followLinks: false — the collection IS the crawl plan (v1
        // behavior): index exactly these URLs, don't self-expand outward.
        const result = await node.seed(urls.slice(i, i + CHUNK), {
          priority: 0.9,
          followLinks: false,
        });
        admitted += result.admitted;
        onProgress?.(Math.min(i + CHUNK, urls.length), urls.length);
      }
      return admitted;
    },
    [],
  );

  const clearAll = useCallback(async () => {
    // The dashboard's "Clear Queue" button: queue only — crawled history
    // and the outbox are kept (node.clearQueue; node.clearAll is the
    // full-reset variant).
    try {
      await nodeRef.current?.clearQueue();
    } catch {
      // IndexedDB unavailable — nothing to clear.
    }
    setStats((prev) => ({ ...prev, queueSize: 0, homeShardJobs: 0 }));
  }, []);

  /**
   * Persist + apply settings. Core config is fixed at node construction, so
   * a settings change rebuilds the node (queue/outbox/crawled all persist in
   * IndexedDB; only session stat counters reset). If the user wants the
   * crawler running, the new node is started subject to constraints.
   */
  const updateSettings = useCallback(
    (patch: Partial<CrawlerSettings>) => {
      const next = { ...settingsRef.current, ...patch };
      settingsRef.current = next;
      saveCrawlerSettings(next);
      setSettings(next);

      const wasRunning = wantsRunning;
      const old = nodeRef.current;
      const node = wireNode(next);
      void (async () => {
        await old?.stop();
        if (wasRunning) {
          const verdict = await checkCrawlConstraints(next);
          if (verdict.ok && nodeRef.current === node) await node.start();
        }
      })();
    },
    [wantsRunning, wireNode],
  );

  const getSettings = useCallback((): CrawlerSettings => settingsRef.current, []);

  const getRelayHealth = useCallback((): Record<string, RelayHealth> => {
    return nodeRef.current?.relayHealth() ?? {};
  }, []);

  /** NIP-11 relay probe through core's guarded choke point (RelayManager). */
  const probeRelay = useCallback(async (url: string): Promise<RelayCapabilities> => {
    const node = nodeRef.current;
    if (!node) return { url, online: false, nip50: false, sip01: false, latencyMs: 0 };
    return node.probeRelay(url);
  }, []);

  return {
    /** User intent: the crawler is "on" (host constraints may pause it). */
    isRunning: wantsRunning,
    initialized,
    stats,
    recentCrawls,
    indexerInfo,
    /** This node's deterministic home shard (0–255). */
    homeShard,
    /** e.g. "A7" */
    homeShardLabel: homeShard === null ? null : shardLabel(homeShard),
    capabilities,
    settings,
    start,
    stop,
    seedUrl,
    seedCollection,
    clearAll,
    updateSettings,
    getSettings,
    getRelayHealth,
    probeRelay,
  };
}
