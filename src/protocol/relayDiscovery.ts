/**
 * Search/index relay auto-discovery — find NIP-50 and SIP-01 capable relays
 * instead of relying on the hardcoded defaults alone.
 *
 * Two-phase, fully client-side:
 *
 *   1. CANDIDATES — NIP-66 relay announcements (kind 30166, addressable,
 *      `d` = relay URL, `N` tags = supported NIPs) are queried from the
 *      search pool with a `#N: ['50']` filter: relays that advertise NIP-50
 *      search. A small seed list of known search relays is always included
 *      so discovery works even on relays that store no 30166s.
 *
 *   2. VERIFICATION — every candidate's NIP-11 document is fetched (via the
 *      CORS proxy; relays serve it over HTTPS at the same host). A relay
 *      joins the DISCOVERED SEARCH tier only when `supported_nips` really
 *      contains 50, and the DISCOVERED INDEX tier when it advertises the
 *      SIP-01 `uncaged_index` block (spec §15). Announcements lie; documents
 *      don't (as much).
 *
 * Results are cached for 24h. Everything is additive: the hardcoded pools
 * keep working with zero discovered relays, and users can hide any
 * discovered relay like any default (Settings → Relays).
 *
 * Privacy: the NIP-66 query is ordinary Nostr-tier traffic. The NIP-11
 * probes go through the CORS proxy, so the whole verification phase is
 * SKIPPED while Privacy Mode is on ("no CORS proxy traffic" wins over
 * discovery); the NIP-66 phase still runs and candidates wait in limbo.
 */

/* ------------------------------------------------------------------ */
/* Self-contained dependency block                                     */
/*                                                                     */
/* VENDORED into @sip01/protocol from sip-01-core@live                 */
/* (src/lib/relayDiscovery.ts, cloned 2026-09-20). Upstream imports    */
/* five app-layer helpers via `@/`; the protocol package must not, so  */
/* they are inlined below — logic verbatim from the upstream modules   */
/* (relayUrls.ts, storageMigration.ts, relayConfig.ts, corsProxy.ts,   */
/* searchRelays.ts), trimmed to the surface this file actually uses.   */
/* Everything below the "Constants" banner is byte-identical to        */
/* upstream.                                                           */
/* ------------------------------------------------------------------ */

import { NRelay1, type NostrEvent, type NostrFilter } from '@nostrify/nostrify';

/* ---- from src/lib/relayUrls.ts (verbatim) ---- */

/** Upgrade ws:// → wss:// when the page itself is HTTPS. */
function toSecureRelayUrl(url: string): string {
  if (typeof location !== 'undefined' && location.protocol === 'https:') {
    return url.replace(/^ws:\/\//i, 'wss://');
  }
  return url;
}

/** Normalize a relay URL: ws/wss only, with trailing slash on bare hosts. */
export function normalizeRelayUrl(input: string): string | null {
  let url = input.trim();
  if (!url) return null;
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    // Only bare hosts get the wss:// prefix — an input that already carries
    // a non-ws scheme (http://, ftp://, …) is not a relay URL at all.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return null;
    url = `wss://${url}`;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return null;
    // Canonical form: origin + pathname, trailing slash on bare hosts.
    const path = parsed.pathname === '/' ? '/' : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return null;
  }
}

/* ---- from src/lib/storageMigration.ts (verbatim) ---- */

/**
 * Read a namespaced localStorage key, falling back to a legacy name. On a
 * legacy hit the value is copied to the canonical key and the legacy key
 * removed — settings migrate on first read.
 */
export function readStoredWithLegacy(canonicalKey: string, legacyKey: string): string | null {
  try {
    const value = localStorage.getItem(canonicalKey);
    if (value !== null) return value;
    const legacyValue = localStorage.getItem(legacyKey);
    if (legacyValue !== null) {
      localStorage.setItem(canonicalKey, legacyValue);
      localStorage.removeItem(legacyKey);
      return legacyValue;
    }
    return null;
  } catch {
    return null;
  }
}

/** Write ONLY the canonical key (and clear the legacy one). null removes. */
export function writeStoredCanonical(canonicalKey: string, legacyKey: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(canonicalKey);
    else localStorage.setItem(canonicalKey, value);
    localStorage.removeItem(legacyKey);
  } catch {
    // Storage unavailable — non-fatal everywhere it's used.
  }
}

/* ---- from src/lib/relayConfig.ts (trimmed to the discovery surface) ---- */

/**
 * The localStorage keys relay discovery reads/writes, plus optional legacy
 * keys for read-through migration. Host applications inject their own key
 * names once at startup via {@link configureRelayDiscoveryStorage}; until
 * then neutral brand-free `sip01:*` defaults apply.
 */
export interface RelayDiscoveryStorageKeys {
  /** Verified relay discovery cache (`{ relays, fetchedAt }`). */
  discoveredRelays: string;
  /** Relay auto-discovery on/off flag (JSON boolean). */
  relayDiscoveryEnabled: string;
  /**
   * Stored app config JSON. Discovery reads only its `privacyMode` flag to
   * decide whether NIP-11 probes (CORS-proxy traffic) may run.
   */
  appConfig: string;
}

export interface RelayDiscoveryConfig {
  storageKeys: RelayDiscoveryStorageKeys;
  /**
   * Legacy localStorage keys for read-through migration, keyed by the
   * canonical key they migrate to.
   */
  legacyStorageKeys: Record<string, string>;
}

/** Neutral defaults — brand-free keys, no legacy migration. */
const NEUTRAL_DISCOVERY_CONFIG: RelayDiscoveryConfig = {
  storageKeys: {
    discoveredRelays: 'sip01:relay-discovery:verified',
    relayDiscoveryEnabled: 'sip01:relay-discovery:enabled',
    appConfig: 'sip01:app-config',
  },
  legacyStorageKeys: {},
};

let runtimeDiscoveryConfig: RelayDiscoveryConfig = NEUTRAL_DISCOVERY_CONFIG;

/** Inject the host application's discovery storage keys. Call once at startup. */
export function configureRelayDiscoveryStorage(config: RelayDiscoveryConfig): void {
  runtimeDiscoveryConfig = config;
}

/** The active discovery storage configuration (neutral until configured). */
export function getRelayDiscoveryConfig(): RelayDiscoveryConfig {
  return runtimeDiscoveryConfig;
}

/** Restore the neutral (unconfigured) defaults. Test helper. */
export function resetRelayDiscoveryConfig(): void {
  runtimeDiscoveryConfig = NEUTRAL_DISCOVERY_CONFIG;
}

/* ---- from src/lib/corsProxy.ts (trimmed to proxiedFetch) ---- */

/**
 * Proxy URL templates, tried in order. Each takes encodeURIComponent(url).
 * A private deployment should override these via its own fetch wrapper —
 * they exist so discovery works out of the box in the reference apps.
 */
const CORS_PROXIES = [
  'https://proxy.shakespeare.diy/?url=',
  'https://api.allorigins.win/raw?url=',
  'https://api.codetabs.com/v1/proxy?quest=',
];

/** Per-attempt timeout (each proxy gets its own window). */
const ATTEMPT_TIMEOUT_MS = 12_000;

/**
 * Loopback/private targets mean the USER'S OWN machine — a remote CORS
 * proxy can never reach them. These go direct.
 */
function isLoopbackOrPrivateUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
      h === 'localhost' || h.endsWith('.localhost')
      || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0'
      || h.endsWith('.local')
      || /^10\./.test(h)
      || /^192\.168\./.test(h)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
      || /^169\.254\./.test(h)
    );
  } catch {
    return false;
  }
}

/** Fetch with CORS-proxy failover (verbatim semantics from corsProxy.ts). */
export async function proxiedFetch(
  url: string,
  init?: RequestInit,
  attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
): Promise<Response> {
  if (url.startsWith('/')) return fetch(url, init);

  if (isLoopbackOrPrivateUrl(url)) {
    const signal = AbortSignal.any([
      ...(init?.signal ? [init.signal] : []),
      AbortSignal.timeout(attemptTimeoutMs),
    ]);
    return fetch(url, { ...init, signal });
  }

  let lastError: unknown = new Error('All CORS proxies failed');

  for (const proxy of CORS_PROXIES) {
    try {
      const signal = AbortSignal.any([
        ...(init?.signal ? [init.signal] : []),
        AbortSignal.timeout(attemptTimeoutMs),
      ]);
      const res = await fetch(`${proxy}${encodeURIComponent(url)}`, { ...init, signal });

      // Target answered (even with an error status) → hand it to the caller.
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return res;

      // 5xx / 429 → proxy or target gateway trouble; try the next proxy.
      lastError = new Error(`HTTP ${res.status} via ${new URL(proxy).hostname}`);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('All CORS proxies failed');
}

/* ---- from src/lib/searchRelays.ts (trimmed to queryRelayPool) ---- */

/** Dedicated relay connections, cached per URL. */
const relayCache = new Map<string, NRelay1>();

function getSearchRelay(url: string): NRelay1 {
  const secure = toSecureRelayUrl(url);
  let relay = relayCache.get(secure);
  if (!relay) {
    relay = new NRelay1(secure);
    relayCache.set(secure, relay);
  }
  return relay;
}

/**
 * Query many relays in parallel, absorbing per-relay failure of ANY kind
 * (a ws:// WebSocket on an https page throws a SYNCHRONOUS SecurityError).
 * Returns per-relay settled results.
 */
export async function queryRelayPool(
  urls: string[],
  filters: NostrFilter[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<NostrEvent[][]> {
  const signal = AbortSignal.any([
    ...(opts.signal ? [opts.signal] : []),
    AbortSignal.timeout(opts.timeoutMs ?? 8000),
  ]);

  const settled = await Promise.allSettled(
    urls.map(async (url) => {
      try {
        return await getSearchRelay(url).query(filters, { signal });
      } catch {
        return [] as NostrEvent[]; // dead/blocked relay = empty contribution
      }
    }),
  );

  return settled.map((r) => (r.status === 'fulfilled' ? r.value : []));
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/**
 * localStorage keys come from the host-injected relay config (relayConfig
 * seam) and are read at call time; legacy keys are read-migrated on first
 * access when the host declares them.
 */
function storageKeys() {
  return getRelayDiscoveryConfig().storageKeys;
}

/** Legacy key for a canonical one, when the host config declares one. */
function legacyKeyFor(key: string): string | undefined {
  return getRelayDiscoveryConfig().legacyStorageKeys[key];
}

/** How long a verified list stays fresh (24h). */
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

/** Cap on NIP-66 candidates probed per refresh (each probe = one proxy fetch). */
const MAX_CANDIDATES = 32;

/** Probe concurrency — polite to the proxy and the relays. */
const PROBE_BATCH = 8;

/** Max discovered relays that join an active pool. */
const MAX_DISCOVERED_SEARCH = 4;
const MAX_DISCOVERED_INDEX = 4;

/**
 * Known search-capable relays that are ALWAYS probed, even when no relay
 * in the bootstrap set stores NIP-66 announcements. (Defaults are excluded
 * at merge time — this list is for relays NOT already shipped.)
 */
const SEED_CANDIDATES = [
  'wss://nostr.wine/', // paid relay with a NIP-50 search API
];

/**
 * Bootstrap relays for the NIP-66 query (kind 30166). Big general-purpose
 * relays with good addressable-event coverage. Callers of
 * refreshDiscoveredRelays() may pass additional bootstrap relays (e.g. the
 * app's own search pool) — merged and deduped here.
 */
const NIP66_BOOTSTRAP = [
  'wss://relay.nostr.band/',
  'wss://relay.primal.net/',
  'wss://relay.damus.io/',
];

/* ------------------------------------------------------------------ */
/* Types + storage                                                     */
/* ------------------------------------------------------------------ */

export interface VerifiedRelay {
  url: string;
  /** NIP-11 `supported_nips` includes 50 → joins the search pool. */
  nip50: boolean;
  /** NIP-11 `uncaged_index.sip01 === true` → joins the SIP-01 index pool. */
  sip01: boolean;
  /** NIP-11 fetch round-trip (ms) — a weak liveness/latency signal. */
  latencyMs: number;
}

interface DiscoveryCache {
  relays: VerifiedRelay[];
  fetchedAt: number;
}

function readJson<T>(key: string): T | null {
  try {
    const legacy = legacyKeyFor(key);
    const raw = legacy ? readStoredWithLegacy(key, legacy) : localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    const legacy = legacyKeyFor(key);
    if (legacy) {
      writeStoredCanonical(key, legacy, JSON.stringify(value));
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // Storage full/unavailable — discovery just won't persist.
  }
}

export function getDiscoveryCache(): DiscoveryCache | null {
  return readJson<DiscoveryCache>(storageKeys().discoveredRelays);
}

/**
 * Whether relay auto-discovery is enabled. ON by default — it only ever
 * adds NIP-11-verified relays, and any of them can be hidden in Settings.
 */
export function isRelayDiscoveryEnabled(): boolean {
  return readJson<boolean>(storageKeys().relayDiscoveryEnabled) !== false;
}

export function setRelayDiscoveryEnabled(enabled: boolean): void {
  writeJson(storageKeys().relayDiscoveryEnabled, enabled);
}

/* ------------------------------------------------------------------ */
/* Phase 1 — NIP-66 candidates                                         */
/* ------------------------------------------------------------------ */

/**
 * Query the bootstrap relays for kind 30166 announcements advertising
 * NIP-50 (`#N: ['50']` — relays index all single-letter tags, NIP-01).
 * Returns normalized clearnet relay URLs from the `d` tags.
 */
async function fetchNip66Candidates(signal?: AbortSignal, extraBootstrap: readonly string[] = []): Promise<string[]> {
  const bootstrap = [...new Set([...NIP66_BOOTSTRAP, ...extraBootstrap])];
  const perRelay = await queryRelayPool(
    bootstrap,
    [{ kinds: [30166], '#N': ['50'], limit: 200 }],
    { signal, timeoutMs: 6000 },
  );

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const events of perRelay) {
    for (const ev of events) {
      const d = ev.tags.find(([n]) => n === 'd')?.[1];
      if (!d) continue;
      // Skip non-clearnet transports (n tag: tor/i2p/loki) — a browser on
      // the clearnet can't dial them anyway.
      const network = ev.tags.find(([n]) => n === 'n')?.[1];
      if (network && network !== 'clearnet') continue;
      const url = normalizeRelayUrl(d);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      candidates.push(url);
    }
  }
  return candidates;
}

/* ------------------------------------------------------------------ */
/* Phase 2 — NIP-11 verification                                       */
/* ------------------------------------------------------------------ */

/** NIP-11 relay information document (the fields we read). */
interface RelayInfoDoc {
  supported_nips?: unknown;
  /** SIP-01 §15: index relays advertise their scope here. */
  uncaged_index?: { sip01?: unknown } | unknown;
}

/**
 * Probe one candidate's NIP-11 document. Returns the verified record, or
 * null when unreachable/not a relay. A relay counts as NIP-50-capable only
 * when its document says so.
 */
async function probeRelay(url: string, signal?: AbortSignal): Promise<VerifiedRelay | null> {
  const httpUrl = url.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
  const start = performance.now();
  try {
    const res = await proxiedFetch(httpUrl, {
      signal,
      headers: { Accept: 'application/nostr+json' },
    });
    if (!res.ok) return null;
    const doc = (await res.json()) as RelayInfoDoc;
    const nips = Array.isArray(doc.supported_nips) ? doc.supported_nips : [];
    const nip50 = nips.includes(50);
    const sip01 =
      typeof doc.uncaged_index === 'object' &&
      doc.uncaged_index !== null &&
      (doc.uncaged_index as { sip01?: unknown }).sip01 === true;
    if (!nip50 && !sip01) return null; // nothing we need — don't waste a slot
    return {
      url,
      nip50,
      sip01,
      latencyMs: Math.round(performance.now() - start),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Refresh                                                             */
/* ------------------------------------------------------------------ */

let discoveryPromise: Promise<VerifiedRelay[]> | null = null;

/** Privacy Mode check — read the stored app config directly (tolerant).
 *  Canonical key first, the host's legacy key as read-through. */
function isPrivacyModeOn(): boolean {
  try {
    const key = storageKeys().appConfig;
    const legacy = legacyKeyFor(key);
    const raw = legacy ? readStoredWithLegacy(key, legacy) : localStorage.getItem(key);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null &&
      (parsed as { privacyMode?: unknown }).privacyMode === true;
  } catch {
    return false;
  }
}

async function runDiscovery(signal?: AbortSignal, extraBootstrap: readonly string[] = []): Promise<VerifiedRelay[]> {
  // Phase 1: candidates (Nostr-tier — fine in Privacy Mode).
  const nip66 = await fetchNip66Candidates(signal, extraBootstrap).catch(() => [] as string[]);
  const candidates = [...new Set([...SEED_CANDIDATES, ...nip66])].slice(0, MAX_CANDIDATES);

  // Phase 2: NIP-11 probes go through the CORS proxy — skipped entirely in
  // Privacy Mode. Candidates stay unverified until a non-private refresh.
  if (isPrivacyModeOn()) return getDiscoveryCache()?.relays ?? [];

  const verified: VerifiedRelay[] = [];
  for (let i = 0; i < candidates.length; i += PROBE_BATCH) {
    if (signal?.aborted) break;
    const batch = candidates.slice(i, i + PROBE_BATCH);
    const settled = await Promise.all(batch.map((url) => probeRelay(url, signal)));
    for (const v of settled) if (v) verified.push(v);
  }

  // Fastest first — the active-tier caps take from the top.
  verified.sort((a, b) => a.latencyMs - b.latencyMs);
  return verified;
}

/**
 * Refresh the verified relay list if stale. Fire-and-forget safe; errors
 * keep the old cache. No-op while discovery is disabled.
 *
 * `bootstrapRelays`: extra relays to include in the NIP-66 candidate query
 * (the host app passes its search pool; discovery itself is pool-agnostic).
 */
export async function refreshDiscoveredRelays(
  force = false,
  signal?: AbortSignal,
  bootstrapRelays: readonly string[] = [],
): Promise<VerifiedRelay[]> {
  if (!isRelayDiscoveryEnabled()) return getDiscoveryCache()?.relays ?? [];

  const cache = getDiscoveryCache();
  if (!force && cache && Date.now() - cache.fetchedAt < DISCOVERY_TTL_MS) return cache.relays;

  if (!discoveryPromise) {
    discoveryPromise = runDiscovery(signal, bootstrapRelays)
      .then((verified) => {
        // Only overwrite the cache with a non-empty sweep — an offline
        // moment must not wipe a healthy verified list.
        if (verified.length > 0) {
          writeJson(storageKeys().discoveredRelays, { relays: verified, fetchedAt: Date.now() } satisfies DiscoveryCache);
        }
        return verified.length > 0 ? verified : (cache?.relays ?? []);
      })
      .catch(() => cache?.relays ?? [])
      .finally(() => {
        discoveryPromise = null;
      });
  }

  return discoveryPromise;
}

/* ------------------------------------------------------------------ */
/* Pool feeds                                                          */
/* ------------------------------------------------------------------ */

/**
 * Verified NIP-50 relays for the search pool (fastest first, capped).
 * Empty when discovery is off or nothing is verified yet.
 */
export function getDiscoveredSearchRelays(): string[] {
  if (!isRelayDiscoveryEnabled()) return [];
  return (getDiscoveryCache()?.relays ?? [])
    .filter((r) => r.nip50)
    .slice(0, MAX_DISCOVERED_SEARCH)
    .map((r) => r.url);
}

/**
 * Verified SIP-01 relays (`uncaged_index` block) for the index pool
 * (fastest first, capped).
 */
export function getDiscoveredIndexRelays(): string[] {
  if (!isRelayDiscoveryEnabled()) return [];
  return (getDiscoveryCache()?.relays ?? [])
    .filter((r) => r.sip01)
    .slice(0, MAX_DISCOVERED_INDEX)
    .map((r) => r.url);
}
