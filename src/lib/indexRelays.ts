/**
 * Indexstr relay pool — app-side relay POLICY (v2).
 *
 * In v1 this lived in `src/crawler/relays.ts`. In v2 the crawler core owns
 * relay *mechanics* (health-gated fan-out, outbox, NIP-11 probing) but the
 * pool itself is host config: the app injects it into `createCrawler` via
 * `config.relays.publish` and uses the read pool for network intake and the
 * heartbeat estimate. The lists stay app-side because they are indexstr's
 * deployment policy, not protocol.
 *
 * Index observations (SIP-01, kind 39697) and node heartbeats (kind 16919)
 * are published to:
 *   1. The SIP-01-aware index relays (validating, NIP-50 operators)
 *   2. The NIP-50 search relay pool (so search engines see them immediately)
 *   3. Public write relays (so they replicate widely)
 *
 * Built-ins can't be removed — they keep every node functional. Users can
 * extend the pool with custom relays (localStorage, this device only);
 * customs merge into getIndexPublishRelays() / getIndexReadRelays().
 *
 * NOTE (v2 seam): the pool is handed to the crawler node at construction,
 * so additions apply on the next node creation (settings change / reload),
 * not mid-cycle as in v1.
 */

/**
 * SIP-01-aware index relays (they validate + index kind 39697 at ingestion
 * and speak the web-search operators).
 */
export const SIP01_RELAYS = [
  'wss://relay-na1.metanomalist.com/',
  'wss://test-sip-relay.sip-01test.workers.dev/',
  'wss://sip-relay-2.sip-booster-relay.workers.dev/',
  'wss://sip-relay-3.uncaged-sip.workers.dev/',
  'wss://sip-relay-4.sip-relay-4.workers.dev/',
];

/**
 * Relays that support NIP-50 search queries.
 * Same defaults as UNCAGED-ENGINE / 0xSearchstr.
 */
export const SEARCH_RELAYS = [
  'wss://relay.nostr.band/',
  'wss://relay.ditto.pub/',
  'wss://search.nos.today/',
  'wss://relay.noswhere.com/',
];

/**
 * Relays that index observations are published to, beyond the search pool,
 * so they propagate widely. search.nos.today is deliberately absent — it
 * answers every write with "blocked: writes disabled"; it stays in the
 * read pool only.
 */
export const INDEX_WRITE_RELAYS = [
  ...SIP01_RELAYS,
  'wss://relay.nostr.band/',
  'wss://relay.ditto.pub/',
  'wss://relay.noswhere.com/',
  'wss://jskitty.cat/nostr',
  'wss://relay.primal.net/',
  'wss://relay.damus.io/',
  'wss://nostr.hifish.org/',
  // Tor-only relay. Reachable from Tor Browser, where .onion is a secure
  // context so plain ws:// is fine (the Tor circuit provides the encryption).
  // On clearnet browsers the hostname never resolves; the core publisher's
  // health gate auto-skips it after repeated failures.
  'ws://acuy3mjnv26tkyaaucndlxmg2ocntz4rtebhavk57vgruozm42iaznqd.onion/',
];

/* ------------------------------------------------------------------------ */
/* Custom relays (user-managed, localStorage)                                */
/* ------------------------------------------------------------------------ */

const LS_CUSTOM_RELAYS = 'indexstr:custom-relays';

function readCustomRelays(): string[] {
  try {
    const raw = localStorage.getItem(LS_CUSTOM_RELAYS);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

function writeCustomRelays(urls: string[]): void {
  try {
    localStorage.setItem(LS_CUSTOM_RELAYS, JSON.stringify(urls));
  } catch {
    // Storage unavailable — non-fatal.
  }
}

/**
 * Normalize a relay URL: wss:// by default (ws:// only for .onion, where the
 * Tor circuit provides the encryption), host lowercased, trailing slash on
 * bare hosts. Returns null for anything else.
 *
 * Kept app-side (stricter than @sip01/protocol's normalizeRelayUrl, which
 * accepts plain ws:// for any host): user-supplied relays must be encrypted
 * unless they are Tor hidden services.
 */
export function normalizeRelayUrl(input: string): string | null {
  let url = input.trim();
  if (!url) return null;
  if (!/^wss?:\/\//i.test(url)) url = `wss://${url}`;

  try {
    const parsed = new URL(url);
    const isOnion = parsed.hostname.toLowerCase().endsWith('.onion');
    if (parsed.protocol === 'ws:' && !isOnion) return null;
    if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return null;
    const path = parsed.pathname === '/' ? '/' : parsed.pathname;
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

/** Get the user's custom relays. */
export function getCustomRelays(): string[] {
  return readCustomRelays();
}

/** All relay URLs the app considers "built in" (can't be removed). */
export function getBuiltinRelays(): string[] {
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const url of [...SEARCH_RELAYS, ...INDEX_WRITE_RELAYS]) {
    if (!seen.has(url)) {
      seen.add(url);
      pool.push(url);
    }
  }
  return pool;
}

/** Add a custom relay. Returns the normalized URL, or null if invalid/duplicate. */
export function addCustomRelay(input: string): string | null {
  const normalized = normalizeRelayUrl(input);
  if (!normalized) return null;
  const current = readCustomRelays();
  if (current.includes(normalized) || getBuiltinRelays().includes(normalized)) {
    return null;
  }
  writeCustomRelays([...current, normalized]);
  return normalized;
}

/** Remove a custom relay (built-ins can't be removed). */
export function removeCustomRelay(url: string): void {
  writeCustomRelays(readCustomRelays().filter((u) => u !== url));
}

/**
 * Relays that observations + heartbeats are published to: SIP-01 index
 * relays first, then the NIP-50 search pool (write-capable members), then
 * propagation relays, then user customs. Deduped.
 *
 * Conformance (blueprint §5, checklist #24): ≥2 relays, ≥1 SIP-01-aware
 * index relay, no read-only proxies — satisfied by construction here.
 */
export function getIndexPublishRelays(): string[] {
  const seen = new Set<string>();
  const pool: string[] = [];
  const writeSearch = SEARCH_RELAYS.filter((u) => u !== 'wss://search.nos.today/');
  for (const url of [...INDEX_WRITE_RELAYS, ...writeSearch, ...readCustomRelays()]) {
    if (!seen.has(url)) {
      seen.add(url);
      pool.push(url);
    }
  }
  return pool;
}

/**
 * Relays this node READS network signals from (intake + heartbeat
 * estimates): the publish pool plus the full NIP-50 search pool, including
 * read-only search.nos.today. Deduped.
 */
export function getIndexReadRelays(): string[] {
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const url of [...getIndexPublishRelays(), ...SEARCH_RELAYS]) {
    if (!seen.has(url)) {
      seen.add(url);
      pool.push(url);
    }
  }
  return pool;
}
