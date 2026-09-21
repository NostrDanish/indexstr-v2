/**
 * Crawler settings — app-side persistence (v2).
 *
 * Settings are host policy: the adapter (hooks/useCrawler.ts) maps them
 * onto a `CrawlerConfig` when it (re)creates the core crawler node. The
 * localStorage key and field names are unchanged from v1 so existing users
 * keep their settings; reads are zod-validated with defaults-on-corruption
 * (audit F9 — v1's raw `JSON.parse` could crash the engine constructor).
 */

import { z } from 'zod';

const SETTINGS_KEY = 'indexstr-settings';

export const crawlerSettingsSchema = z.object({
  wifiOnly: z.boolean().catch(false),
  chargingOnly: z.boolean().catch(false),
  respectRobots: z.boolean().catch(true),
  /** Session bandwidth cap (MB), mapped to the core byte budget.
   *  0 = UNLIMITED (cap fully off — the node just runs). Default 250. */
  maxBandwidthMB: z.number().min(0).catch(250),
  /** Sliding-window global fetch budget. */
  maxPagesPerHour: z.number().positive().catch(500),
  /** Link-follow depth for manual seeds. */
  maxDepth: z.number().int().min(0).catch(3),
  /** Parallel fetch slots (core accepts 1–8; default matches core). */
  maxConcurrent: z.number().int().min(1).max(8).catch(4),
  /** Hard page-size cap passed to the stream-capped reader. */
  maxPageSizeKB: z.number().positive().catch(2048),
  ecoMode: z.boolean().catch(true),
  /** v2 (P4): feed/sitemap discovery opt-in — cheap structured discovery,
   *  crawlstr's value-add generalized to the network node (blueprint §6). */
  followFeeds: z.boolean().catch(true),
  followSitemaps: z.boolean().catch(true),
});

export type CrawlerSettings = z.infer<typeof crawlerSettingsSchema>;

export const DEFAULT_CRAWLER_SETTINGS: CrawlerSettings = crawlerSettingsSchema.parse({});

/** Load settings, tolerating missing/corrupt JSON and wrong field types. */
export function loadCrawlerSettings(): CrawlerSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_CRAWLER_SETTINGS;
    return crawlerSettingsSchema.parse(JSON.parse(raw));
  } catch {
    return DEFAULT_CRAWLER_SETTINGS;
  }
}

export function saveCrawlerSettings(settings: CrawlerSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable — settings revert on reload, non-fatal.
  }
}
