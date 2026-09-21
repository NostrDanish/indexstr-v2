/**
 * heartbeat.ts — crawler node heartbeat, kind 16919 (replaceable).
 *
 * A running node publishes a small signed heartbeat (on start + every
 * 10 min) so the network can answer "who is indexing right now?" without
 * any coordinator. One replaceable event per node; the latest write wins.
 * Heartbeats older than HEARTBEAT_TTL_S count as offline.
 *
 * A heartbeat is *self-reported and unverified* — useful for coverage and
 * health estimates. It is NOT a reputation input: reputation derives from
 * signed kind 39697 observations (independent, comparable), never from
 * self-reports. No reputation consumer may import these stats.
 *
 * Privacy: coarse capability classes only (battery rounded to quarters,
 * network reduced to a class). No location, no IP, no device model, no
 * fine-grained fingerprint. Counters are coarsened before signing
 * (indexstr F14): exact totals never leave the device — see coarsenCount.
 */

import type { NostrEvent } from '@nostrify/nostrify';
import { nodeShard, shardLabel } from './sharding';

/**
 * Coarsen a counter to two significant figures, rounding DOWN (indexstr F14):
 * exact below 100, then nearest 10/100/1k/… — 123 → 120, 12_345 → 12_000.
 * Heartbeats are a health/coverage signal; exact totals would be a
 * fingerprint and are never needed by consumers (which clamp via
 * Math.max(0, …) on parse anyway).
 */
export function coarsenCount(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < 100) return Math.floor(n);
  const step = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.floor(n / step) * step;
}

/** Replaceable event kind for crawler node heartbeats. */
export const HEARTBEAT_KIND = 16919;

/** Heartbeats older than this are considered offline (seconds). */
export const HEARTBEAT_TTL_S = 3600;

/** How often a running node re-publishes its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

export interface HeartbeatStats {
  pagesIndexed: number;
  queueSize: number;
  published: number;
}

export interface HeartbeatPayload {
  v: string;
  shard: string;
  platform: string;
  network: string;
  charging: boolean;
  stats: HeartbeatStats;
}

export interface ParsedHeartbeat extends HeartbeatPayload {
  pubkey: string;
  createdAt: number;
  /** Indexer software id from the `source` tag, when present. */
  source?: string;
}

/** Coarse capability snapshot — guarded for non-browser runtimes. */
export interface CoarseCapabilities {
  platform: 'mobile' | 'desktop' | 'unknown';
  network: 'wifi-or-better' | 'cellular' | 'slow' | 'offline' | 'unknown';
  charging: boolean;
}

export async function getCoarseCapabilities(): Promise<CoarseCapabilities> {
  if (typeof navigator === 'undefined') {
    return { platform: 'unknown', network: 'unknown', charging: false };
  }
  const ua = navigator.userAgent ?? '';
  const platform = /Mobi|Android|iPhone|iPad/i.test(ua) ? 'mobile' : ua ? 'desktop' : 'unknown';

  const conn = (navigator as { connection?: { effectiveType?: string; type?: string } })
    .connection;
  let network: CoarseCapabilities['network'] = 'unknown';
  if (conn) {
    if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') network = 'slow';
    else if (conn.type === 'wifi' || conn.effectiveType === '4g') network = 'wifi-or-better';
    else if (conn.type === 'cellular' || conn.effectiveType === '3g') network = 'cellular';
    else if (navigator.onLine === false) network = 'offline';
  }

  let charging = false;
  if ('getBattery' in navigator) {
    try {
      const battery = await (
        navigator as unknown as { getBattery(): Promise<{ charging: boolean }> }
      ).getBattery();
      charging = battery.charging;
    } catch {
      // Battery API unavailable/blocked — leave as false.
    }
  }

  return { platform, network, charging };
}

export interface HeartbeatConfig {
  source: string; // e.g. 'crawlstr/v2', 'indexstr/v2'
  indexerPubkey: string;
  /**
   * Node protocol version reported in the heartbeat `v` tag/payload —
   * the node SOFTWARE's major version ('2' for indexstr/v2 nodes), so the
   * SIP-01 dashboard can tell node generations apart. Defaults to '1'
   * (the historical crawler-core value).
   */
  nodeVersion?: string;
  /** Host-injected signer (same seam as observations). */
  signer: (event: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }) => Promise<NostrEvent>;
  clock?: () => number;
}

/** Build and sign this node's heartbeat. */
export async function buildHeartbeat(
  stats: HeartbeatStats,
  config: HeartbeatConfig,
): Promise<NostrEvent> {
  const clock = config.clock ?? Date.now;
  const caps = await getCoarseCapabilities();
  const shard = nodeShard(config.indexerPubkey);
  const label = shardLabel(shard);

  const nodeVersion = config.nodeVersion ?? '1';

  const payload: HeartbeatPayload = {
    v: nodeVersion,
    shard: label,
    platform: caps.platform,
    network: caps.network,
    charging: caps.charging,
    stats: {
      pagesIndexed: coarsenCount(stats.pagesIndexed),
      queueSize: coarsenCount(stats.queueSize),
      published: coarsenCount(stats.published),
    },
  };

  return config.signer({
    kind: HEARTBEAT_KIND,
    created_at: Math.floor(clock() / 1000),
    content: JSON.stringify(payload),
    tags: [
      ['v', nodeVersion],
      ['shard', label],
      ['source', config.source],
      ['alt', `Crawler node heartbeat: shard ${label}`],
    ],
  });
}

/**
 * Structural validation for incoming heartbeats. Aligned with the canonical
 * port in the SIP-01 repo (src/lib/heartbeat.ts): lowercase hex shards are
 * accepted and normalized to uppercase; `source` is read from the tags.
 */
export function parseHeartbeat(event: NostrEvent): ParsedHeartbeat | null {
  if (event.kind !== HEARTBEAT_KIND) return null;
  try {
    const payload = JSON.parse(event.content) as Partial<HeartbeatPayload>;
    const shard = payload.shard;
    if (typeof shard !== 'string' || !/^[0-9A-Fa-f]{2}$/.test(shard)) return null;
    if (typeof payload.v !== 'string') return null;
    return {
      pubkey: event.pubkey,
      createdAt: event.created_at,
      v: payload.v,
      shard: shard.toUpperCase(),
      platform: typeof payload.platform === 'string' ? payload.platform.slice(0, 16) : 'unknown',
      network: typeof payload.network === 'string' ? payload.network.slice(0, 24) : 'unknown',
      charging: payload.charging === true,
      stats: {
        pagesIndexed: Math.max(0, Number(payload.stats?.pagesIndexed) || 0),
        queueSize: Math.max(0, Number(payload.stats?.queueSize) || 0),
        published: Math.max(0, Number(payload.stats?.published) || 0),
      },
      source: event.tags.find(([n]) => n === 'source')?.[1],
    };
  } catch {
    return null;
  }
}

/** Latest heartbeat per node pubkey (kind 16919 is replaceable, but a
 *  multi-relay query can still return stale versions — collapse). */
export function dedupeHeartbeats(events: NostrEvent[]): ParsedHeartbeat[] {
  const latest = new Map<string, ParsedHeartbeat>();
  for (const event of events) {
    const hb = parseHeartbeat(event);
    if (!hb) continue;
    const prev = latest.get(hb.pubkey);
    if (!prev || hb.createdAt > prev.createdAt) latest.set(hb.pubkey, hb);
  }
  return [...latest.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** True when the heartbeat is fresh enough to count the node as online. */
export function isNodeLive(hb: ParsedHeartbeat, now = Math.floor(Date.now() / 1000)): boolean {
  return now - hb.createdAt <= HEARTBEAT_TTL_S;
}
