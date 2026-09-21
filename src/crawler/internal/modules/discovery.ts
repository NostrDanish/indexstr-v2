/**
 * discovery.ts — RSS/Atom feed + XML sitemap discovery (OPTIONAL module;
 * crawlstr on by default, indexstr opt-in).
 *
 * Feeds are the cheapest high-quality crawl source on the web: one small
 * XML document yields current, canonical content URLs with titles, summaries
 * and dates. Sitemaps are the site's own map of itself. Both are SAMPLED,
 * bounded, and every fetch goes through net.ts (the guarded choke point).
 *
 * Parsing is pure (DOMParser on XML); the Discovery class carries the
 * fetching + admission wiring the engine uses after a successful page crawl.
 */

import type { Net } from '../net';

export interface FeedEntry {
  url: string;
  title: string;
  summary?: string;
  published?: number;
}

export interface ParsedFeed {
  title: string;
  entries: FeedEntry[];
}

export interface ParsedSitemap {
  /** Page URLs from a <urlset>. */
  urls: string[];
  /** Child sitemap URLs from a <sitemapindex>. */
  sitemaps: string[];
}

/** True when the text looks like a feed document. */
export function looksLikeFeed(xml: string): boolean {
  const head = xml.slice(0, 2000);
  return head.includes('<rss') || head.includes('<feed') || head.includes('<rdf:RDF');
}

/** True when the text looks like a sitemap document. */
export function looksLikeSitemap(xml: string): boolean {
  const head = xml.slice(0, 2000);
  return head.includes('<urlset') || head.includes('<sitemapindex');
}

/** Parse an RSS 2.0 or Atom feed document. Returns null when unrecognizable. */
export function parseFeed(xml: string, feedUrl: string, maxEntries = 10): ParsedFeed | null {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) return null;

  // --- Atom ---
  const atomEntries = doc.querySelectorAll('feed > entry');
  if (atomEntries.length > 0) {
    const title = doc.querySelector('feed > title')?.textContent?.trim() ?? '';
    const entries: FeedEntry[] = [];

    atomEntries.forEach((entry, i) => {
      if (i >= maxEntries) return;
      const entryTitle = entry.querySelector('title')?.textContent?.trim() ?? '';
      const linkEl = entry.querySelector('link[rel="alternate"]') ?? entry.querySelector('link');
      const href = linkEl?.getAttribute('href') ?? linkEl?.textContent?.trim() ?? '';
      const dateRaw =
        entry.querySelector('published')?.textContent?.trim() ??
        entry.querySelector('updated')?.textContent?.trim() ??
        '';
      const summary =
        entry.querySelector('summary')?.textContent?.trim() ??
        entry.querySelector('content')?.textContent?.trim().slice(0, 500) ??
        '';

      if (!href) return;
      try {
        const url = new URL(href, feedUrl).href;
        if (!url.startsWith('http')) return;
        const ts = dateRaw ? Math.floor(new Date(dateRaw).getTime() / 1000) : NaN;
        entries.push({
          url,
          title: entryTitle || url,
          summary: summary || undefined,
          published: Number.isFinite(ts) && ts > 0 ? ts : undefined, // C-1: drop pre-1970 claims
        });
      } catch {
        // Invalid URL, skip
      }
    });

    return { title, entries };
  }

  // --- RSS 2.0 / RDF ---
  const items = doc.querySelectorAll('channel > item, item');
  if (items.length > 0) {
    const title = doc.querySelector('channel > title')?.textContent?.trim() ?? '';
    const entries: FeedEntry[] = [];

    items.forEach((item, i) => {
      if (i >= maxEntries) return;
      const entryTitle = item.querySelector('title')?.textContent?.trim() ?? '';
      const link = item.querySelector('link')?.textContent?.trim() ?? '';
      const guid = item.querySelector('guid')?.textContent?.trim() ?? '';
      const dateRaw = item.querySelector('pubDate')?.textContent?.trim() ?? '';
      const summary = item.querySelector('description')?.textContent?.trim().slice(0, 500) ?? '';

      const href = link || guid;
      if (!href) return;
      try {
        const url = new URL(href, feedUrl).href;
        if (!url.startsWith('http')) return;
        const ts = dateRaw ? Math.floor(new Date(dateRaw).getTime() / 1000) : NaN;
        entries.push({
          url,
          title: entryTitle || url,
          summary: summary || undefined,
          published: Number.isFinite(ts) && ts > 0 ? ts : undefined, // C-1: drop pre-1970 claims
        });
      } catch {
        // Invalid URL, skip
      }
    });

    return { title, entries };
  }

  return null;
}

/** Parse a sitemap document (<urlset> or <sitemapindex>). */
export function parseSitemap(xml: string, baseUrl: string): ParsedSitemap | null {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) return null;

  const result: ParsedSitemap = { urls: [], sitemaps: [] };

  const collect = (locs: NodeListOf<Element>, into: string[]) => {
    locs.forEach((loc) => {
      const text = loc.textContent?.trim();
      if (!text) return;
      try {
        const url = new URL(text, baseUrl).href;
        if (url.startsWith('http')) into.push(url);
      } catch {
        // Invalid URL, skip
      }
    });
  };

  collect(doc.querySelectorAll('urlset > url > loc, url > loc'), result.urls);
  collect(doc.querySelectorAll('sitemapindex > sitemap > loc, sitemap > loc'), result.sitemaps);

  result.urls = [...new Set(result.urls)];
  result.sitemaps = [...new Set(result.sitemaps)];

  if (result.urls.length === 0 && result.sitemaps.length === 0) return null;
  return result;
}

/**
 * Pick up to `count` items with a cheap deterministic spread (evenly spaced
 * through the list rather than always the first N — the head of a sitemap is
 * often the newest or the nav pages).
 */
export function sampleUrls(urls: string[], count: number): string[] {
  if (urls.length <= count) return urls;
  const step = urls.length / count;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(urls[Math.floor(i * step)]!);
  }
  return out;
}

export interface DiscoveryHooks {
  /** Fetch + parse one feed; returns its entries (empty when unusable). */
  followFeed(feedUrl: string): Promise<{ entries: FeedEntry[] } | null>;
  /** Probe an origin for sitemaps; returns sampled page URLs. */
  probeSitemaps(origin: string): Promise<string[]>;
}

/**
 * The fetching half of discovery. All requests go through net.ts, so the
 * SSRF guard and the byte meter apply to feeds and sitemaps exactly as to
 * pages (v1's unmetered/unguarded discovery fetches are gone).
 */
export class Discovery implements DiscoveryHooks {
  constructor(
    private readonly net: Net,
    private readonly getSitemaps: (origin: string) => Promise<string[]>,
    private readonly sampleSize: number,
  ) {}

  async followFeed(feedUrl: string): Promise<{ entries: FeedEntry[] } | null> {
    const outcome = await this.net.guardedFetchXml(feedUrl);
    if (!outcome.ok || !looksLikeFeed(outcome.body)) return null;
    const feed = parseFeed(outcome.body, feedUrl, this.sampleSize);
    if (!feed || feed.entries.length === 0) return null;
    return { entries: feed.entries };
  }

  async probeSitemaps(origin: string): Promise<string[]> {
    const candidates = await this.getSitemaps(origin + '/');
    const fallback = `${origin}/sitemap.xml`;
    if (candidates.length === 0) candidates.push(fallback);

    const out: string[] = [];
    for (const sitemapUrl of candidates.slice(0, 2)) {
      const outcome = await this.net.guardedFetchXml(sitemapUrl);
      if (!outcome.ok || !looksLikeSitemap(outcome.body)) continue;

      const sitemap = parseSitemap(outcome.body, sitemapUrl);
      if (!sitemap) continue;

      out.push(...sampleUrls(sitemap.urls, this.sampleSize));

      // Sitemap index: follow ONE child sitemap for a taste of what's inside.
      if (sitemap.sitemaps.length > 0 && sitemap.urls.length === 0) {
        const child = sitemap.sitemaps[Math.floor(Math.random() * sitemap.sitemaps.length)]!;
        const childOutcome = await this.net.guardedFetchXml(child);
        if (childOutcome.ok && looksLikeSitemap(childOutcome.body)) {
          const childSitemap = parseSitemap(childOutcome.body, child);
          if (childSitemap) out.push(...sampleUrls(childSitemap.urls, this.sampleSize));
        }
      }
    }
    return out;
  }
}
