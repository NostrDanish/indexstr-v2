/**
 * Crawl-trap guards.
 *
 * At network scale the queue must defend itself: calendar generators,
 * session-id URLs, endless paginators and internal search pages create
 * infinite URL space that would eat the entire crawl budget. Collections
 * are curated so they bypass this; guards apply to *discovered* URLs
 * (link following + network intake).
 *
 * Heuristics are deliberately conservative: false positives cost one page,
 * false negatives cost infinite crawl budget.
 */

/** Query keys that identify per-visitor session state — never indexable. */
const SESSION_KEYS = new Set([
  'sid', 'session', 'sessionid', 'sessid', 'phpsessid', 'jsessionid',
  'aspsessionid', 'asp.net_sessionid', 'cfid', 'cftoken', 'zenid', 'oscsid',
]);

/** Path segments that generate unbounded URL space. */
const TRAP_SEGMENTS = new Set([
  'calendar', 'cart', 'checkout', 'basket',
]);

/**
 * True when a URL looks like a crawl trap / infinite-space generator.
 * Input should already be SIP-01-normalized.
 */
export function isLikelyCrawlTrap(normalizedUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(normalizedUrl);
  } catch {
    return true;
  }

  // 1. Session-state query keys.
  for (const key of url.searchParams.keys()) {
    if (SESSION_KEYS.has(key.toLowerCase())) return true;
  }

  // 2. Absurd query complexity (filter-combination generators).
  if ([...url.searchParams.keys()].length > 6) return true;

  const segments = url.pathname.split('/').filter(Boolean);
  const lowered = segments.map((s) => s.toLowerCase());

  // 3. Trap path segments.
  if (lowered.some((s) => TRAP_SEGMENTS.has(s))) return true;

  // 4. Same segment repeating 3+ times (a/b/a/b/a = generator loop).
  for (let i = 2; i < lowered.length; i++) {
    if (lowered[i] === lowered[i - 1] && lowered[i] === lowered[i - 2]) return true;
  }

  // 5. Very long pure-numeric path segment (9+ digits) — counter space.
  if (lowered.some((s) => /^\d{9,}$/.test(s))) return true;

  // 6. Extreme depth.
  if (segments.length > 8) return true;

  return false;
}

/**
 * Per-domain guard against one host flooding the queue through discovery.
 * Collections are exempt (they are the curated plan).
 */
export class DomainIntakeGuard {
  private counts = new Map<string, number>();

  constructor(private readonly maxPerDomain: number) {}

  /** True when this URL may still be accepted. */
  allow(normalizedUrl: string): boolean {
    let host: string;
    try {
      host = new URL(normalizedUrl).hostname;
    } catch {
      return false;
    }
    const count = this.counts.get(host) ?? 0;
    if (count >= this.maxPerDomain) return false;
    this.counts.set(host, count + 1);
    return true;
  }
}

/**
 * Per-indexer Sybil guard for network intake.
 *
 * Anyone can publish kind 39697 events, so a single flooding indexer could
 * otherwise turn every listening node into its free crawl army: 10k domains
 * × 200 URLs each sails under the per-domain cap. This guard caps how many
 * intake URLs one indexer pubkey may contribute per session. Honest bursts
 * (a crawler publishing its day's work) fit comfortably; a flood does not.
 *
 * Deliberately NOT a reputation system — no scoring, no memory beyond the
 * session, no central list. Reputation belongs to the search side, derived
 * from observation agreement.
 */
export class IndexerIntakeGuard {
  private counts = new Map<string, number>();

  constructor(private readonly maxPerIndexer: number) {}

  /** True when this indexer may still contribute intake URLs. */
  allow(pubkey: string): boolean {
    const count = this.counts.get(pubkey) ?? 0;
    if (count >= this.maxPerIndexer) return false;
    this.counts.set(pubkey, count + 1);
    return true;
  }

  /** How many distinct indexers have contributed this session. */
  get indexerCount(): number {
    return this.counts.size;
  }
}
