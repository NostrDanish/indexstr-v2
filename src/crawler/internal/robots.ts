/**
 * robots.ts — robots.txt fetch + parse + cache.
 *
 * robots.txt is itself a cross-origin request, so it goes through the SAME
 * guardedFetch choke point as everything else (net.ts) — there is no fetch
 * code here. That makes the P0 ordering bug (robots fetched before the
 * page's SSRF check) unrepresentable: this module cannot reach the network
 * without passing the guard, and the engine runs the guard before robots.
 *
 * Defense in depth: a robots lookup for a private host is a REFUSAL
 * (fail closed), not "allowed" — shouldCrawlUrl returns false and no
 * request is ever issued.
 *
 * Policy on unreachability (fail open, unchanged from v1): a public host
 * whose robots.txt cannot be fetched (network down, proxy blocked) is
 * treated as allowed; a 4xx is treated as "no robots.txt" (allowed).
 *
 * P4 upgrade: `Allow:` directives are parsed and the RFC 9309 longest-match
 * rule decides — the longest matching path prefix wins, and an Allow/Disallow
 * tie resolves to allowed. Remaining documented subset: no `*`/`$` wildcard
 * pattern matching (plain prefix rules only, as in v1).
 */

import type { Net } from './net';
import { isPrivateHost } from './guard';

export interface RobotsRules {
  disallowed: string[];
  /** RFC 9309 Allow rules (same prefix-match shape as disallowed). */
  allowed: string[];
  crawlDelay?: number;
  sitemaps: string[];
}

const CACHE_TTL = 3_600_000; // 1 hour
/** Hard cap on cached origins (LRU-ish sweep beyond this). */
const MAX_CACHE_ENTRIES = 5000;

export class Robots {
  private readonly cache = new Map<string, { rules: RobotsRules; fetchedAt: number }>();

  constructor(
    private readonly net: Net,
    private readonly clock: () => number = Date.now,
  ) {}

  async shouldCrawlUrl(url: string): Promise<boolean> {
    try {
      const urlObj = new URL(url);
      // SSRF defense in depth: NEVER fetch robots.txt from a private host.
      if (isPrivateHost(urlObj.hostname)) return false;
      const robotsUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;

      const rules = await this.getRules(robotsUrl);
      if (!rules) return true; // No robots.txt / unreachable = allowed

      const path = urlObj.pathname;
      // RFC 9309 longest-match: the longest matching prefix rule wins;
      // an Allow/Disallow tie resolves to allowed. `Disallow: /` matches
      // every path (length 1), so a longer Allow rule overrides it.
      let longestDisallow = -1;
      for (const rule of rules.disallowed) {
        if (rule && path.startsWith(rule) && rule.length > longestDisallow) {
          longestDisallow = rule.length;
        }
      }
      if (longestDisallow === -1) return true;
      let longestAllow = -1;
      for (const rule of rules.allowed) {
        if (rule && path.startsWith(rule) && rule.length > longestAllow) {
          longestAllow = rule.length;
        }
      }
      return longestAllow >= longestDisallow;
    } catch {
      return true; // Error = assume allowed
    }
  }

  /** Crawl-delay in ms (0 when none / unreachable / private). */
  async getCrawlDelay(url: string): Promise<number> {
    try {
      const urlObj = new URL(url);
      if (isPrivateHost(urlObj.hostname)) return 0;
      const robotsUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;
      const rules = await this.getRules(robotsUrl);
      return rules?.crawlDelay ?? 0;
    } catch {
      return 0;
    }
  }

  /** True when FRESH cached rules exist for the URL's origin — pure cache
   *  peek, NEVER triggers a fetch. The parallel scheduler uses this to
   *  decide whether a slot must run a robots warm-up request first. */
  hasCachedRules(url: string): boolean {
    try {
      const urlObj = new URL(url);
      const cached = this.cache.get(`${urlObj.protocol}//${urlObj.host}/robots.txt`);
      return cached !== undefined && this.clock() - cached.fetchedAt < CACHE_TTL;
    } catch {
      return false;
    }
  }

  /** Crawl-delay in ms from the CACHE ONLY (0 when unknown/uncached).
   *  Never fetches — the dispatch path reads this after warm(). */
  peekCrawlDelay(url: string): number {
    try {
      const urlObj = new URL(url);
      const cached = this.cache.get(`${urlObj.protocol}//${urlObj.host}/robots.txt`);
      if (!cached || this.clock() - cached.fetchedAt >= CACHE_TTL) return 0;
      return cached.rules.crawlDelay ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Fetch + cache robots.txt for the URL's origin (through the choke point;
   * private hosts are never fetched). The engine runs this as a SCHEDULED
   * request on the domain's lane — robots traffic counts toward the
   * per-domain interval (politeness invariant ii).
   */
  async warm(url: string): Promise<void> {
    try {
      const urlObj = new URL(url);
      if (isPrivateHost(urlObj.hostname)) return; // fail closed, zero requests
      await this.getRules(`${urlObj.protocol}//${urlObj.host}/robots.txt`);
    } catch {
      // Best-effort — unreachable robots means 'allowed' at policy time.
    }
  }

  /** The robots.txt URL for a page URL's origin (scheduler lane key). */
  static robotsUrlFor(url: string): string | null {
    try {
      const urlObj = new URL(url);
      return `${urlObj.protocol}//${urlObj.host}/robots.txt`;
    } catch {
      return null;
    }
  }

  /** Sitemap URLs declared in robots.txt (same cache — no extra request). */
  async getSitemaps(url: string): Promise<string[]> {
    try {
      const urlObj = new URL(url);
      if (isPrivateHost(urlObj.hostname)) return [];
      const robotsUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;
      const rules = await this.getRules(robotsUrl);
      return rules?.sitemaps ?? [];
    } catch {
      return [];
    }
  }

  private async getRules(robotsUrl: string): Promise<RobotsRules | null> {
    const cached = this.cache.get(robotsUrl);
    if (cached && this.clock() - cached.fetchedAt < CACHE_TTL) return cached.rules;

    // Through the choke point: the guard runs inside net.guardedFetch.
    const outcome = await this.net.guardedFetchText(robotsUrl, { timeoutMs: 8000 });
    if (!outcome.ok) {
      if (outcome.reason === 'ssrf') return null; // private — caller refuses
      // 4xx = no robots.txt (allowed); transient = unreachable (caller policy).
      return outcome.kind === 'permanent' && outcome.reason === 'http-4xx'
        ? this.remember(robotsUrl, { disallowed: [], allowed: [], sitemaps: [] })
        : null;
    }
    return this.remember(robotsUrl, parseRobotsTxt(outcome.body));
  }

  private remember(robotsUrl: string, rules: RobotsRules): RobotsRules {
    this.cache.set(robotsUrl, { rules, fetchedAt: this.clock() });
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const entries = [...this.cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
      for (const [k] of entries.slice(0, Math.floor(entries.length / 2))) this.cache.delete(k);
    }
    return rules;
  }

  /** Test hook: clear the cache. */
  reset(): void {
    this.cache.clear();
  }
}

export function parseRobotsTxt(text: string): RobotsRules {
  const lines = text.split('\n');
  const disallowed: string[] = [];
  const allowed: string[] = [];
  const sitemaps: string[] = [];
  let crawlDelay: number | undefined;
  let relevantAgent = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const directive = trimmed.slice(0, colonIndex).trim().toLowerCase();
    const value = trimmed.slice(colonIndex + 1).trim();

    // Sitemap is a global directive — applies regardless of user-agent.
    if (directive === 'sitemap' && value) {
      sitemaps.push(value);
      continue;
    }

    if (directive === 'user-agent') {
      const agent = value.toLowerCase();
      relevantAgent =
        agent === '*' ||
        agent.includes('searchstr') ||
        agent.includes('crawlstr') ||
        agent.includes('indexstr');
    }

    if (relevantAgent) {
      if (directive === 'disallow' && value) disallowed.push(value);
      if (directive === 'allow' && value) allowed.push(value);
      if (directive === 'crawl-delay') {
        const delay = parseInt(value);
        if (!isNaN(delay)) crawlDelay = delay * 1000; // → ms
      }
    }
  }

  return { disallowed, allowed, crawlDelay, sitemaps };
}
