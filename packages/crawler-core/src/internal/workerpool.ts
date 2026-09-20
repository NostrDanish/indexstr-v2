/**
 * workerpool.ts — parse/hash/enrich in a Web Worker pool (P3, blueprint §3.1).
 *
 * The heavy per-page work (HTML parse → text/link/meta extraction → sha256
 * content hash → optional enrich) runs OFF the main thread: workers parse
 * via linkedom (pure JS; `DOMParser` with text/html is not reliably
 * available in workers on Chromium). Only the small structured-cloneable
 * ProcessedPage crosses the boundary, so a 2 MB page can't jank the
 * dashboard (p95 main-thread long-task <50 ms by construction — no parse
 * work remains on the main thread).
 *
 * Environment fallbacks (the pool is behind the PageProcessor interface):
 *   - Node / vitest / no Worker global → InlineProcessor (main-thread
 *     DOMParser), same results;
 *   - Worker construction or runtime failure → all pending + future pages
 *     reprocessed inline;
 *   - HTML4-era pages with UPPERCASE attribute names (<META NAME=...>):
 *     linkedom (pinned 0.18.13) does not lowercase attribute names (the one
 *     divergence found in the 23-page fidelity spike) — a cheap pre-scan of
 *     the first 8 KB routes those pages to the main-thread DOMParser, plus
 *     a belt-and-braces lang-claim cross-check on worker results.
 *
 * The parser below is the UNION of both v1 apps' parsers:
 *   crawlstr: feeds (rel=alternate), canonical URL, published>0 clamp (C-1)
 *   indexstr: og:type, JSON-LD @types, headings, richer keyword filtering
 */

import type { FeedLink, ParsedPage } from './types';
import { enrichPage, type Enrichment } from './modules/enrich';

export interface ProcessedPage {
  parsed: ParsedPage;
  /** sha256 of extracted text — local dedup + freshness change detection. */
  contentHash: string;
  /** Present when the enrich module was requested for this page. */
  enrichment?: Enrichment;
}

export interface ProcessPageOptions {
  /** Run the enrich module (topic lexicon + doc-type) on the worker. */
  enrich?: boolean;
}

/** The parse/hash/enrich boundary — engine depends on this, not on the
 *  worker machinery. */
export interface PageProcessor {
  processPage(
    html: string,
    baseUrl: string,
    opts?: ProcessPageOptions,
  ): Promise<ProcessedPage>;
  dispose(): Promise<void>;
}

/** SHA-256 hex digest of a string, prefixed ('sha256:…'). */
export async function hashContent(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

/* ---------------------------------------------------------------------- */
/* Fallback routing (spike findings #2 + belt-and-braces #3)               */
/* ---------------------------------------------------------------------- */

/** Uppercase attribute name inside a tag (<META NAME=...>) — the linkedom
 *  non-conformance class found by the fidelity spike. */
const UPPERCASE_ATTR_RE = /<[a-zA-Z][^>]*\s[A-Z][A-Z0-9_-]*=/;
/** html lang claim (any case) for the post-parse cross-check. */
const LANG_CLAIM_RE = /<html[^>]*?\blang\s*=\s*["']?([a-zA-Z-]+)/i;

/** True when the page must be parsed on the main thread with the native
 *  (spec-conformant) DOMParser instead of a linkedom worker. */
export function needsMainThreadParse(html: string): boolean {
  return UPPERCASE_ATTR_RE.test(html.slice(0, 8192));
}

/** Belt-and-braces: the worker result's language must match a lang= claim
 *  visible in the raw head — a mismatch means linkedom missed an attribute. */
function langMismatch(html: string, parsed: ParsedPage): boolean {
  const claim = LANG_CLAIM_RE.exec(html.slice(0, 4096));
  if (!claim) return false;
  return parsed.language !== claim[1]!.toLowerCase().split('-')[0];
}

/* ---------------------------------------------------------------------- */
/* Inline (main-thread) processor — tests, Node, worker-less environments  */
/* ---------------------------------------------------------------------- */

/** Parse + hash + optional enrich on the calling thread. */
export async function processInline(
  html: string,
  baseUrl: string,
  enrich: boolean,
): Promise<ProcessedPage> {
  const parsed = parsePage(html, baseUrl);
  const contentHash = await hashContent(parsed.text);
  return {
    parsed,
    contentHash,
    ...(enrich ? { enrichment: enrichPage(parsed, baseUrl) } : {}),
  };
}

export class InlineProcessor implements PageProcessor {
  processPage(
    html: string,
    baseUrl: string,
    opts?: ProcessPageOptions,
  ): Promise<ProcessedPage> {
    return processInline(html, baseUrl, opts?.enrich ?? false);
  }

  async dispose(): Promise<void> {}
}

/* ---------------------------------------------------------------------- */
/* Web Worker pool                                                         */
/* ---------------------------------------------------------------------- */

/** Wire protocol for worker.ts. */
export interface WorkerPageRequest {
  id: number;
  html: string;
  baseUrl: string;
  enrich: boolean;
}

export type WorkerPageResponse =
  | { id: number; ok: true; result: ProcessedPage }
  | { id: number; ok: false; error: string };

interface PendingRequest extends WorkerPageRequest {
  resolve: (page: ProcessedPage | Promise<ProcessedPage>) => void;
  reject: (error: Error) => void;
}

const MAX_WORKERS = 8;

export class WorkerPool implements PageProcessor {
  private workers: Worker[] | null = null;
  private workersFailed = false;
  private disposed = false;
  private readonly inline = new InlineProcessor();
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private roundRobin = 0;

  constructor(readonly requestedWorkers: number = 1) {}

  /**
   * Lazily create the workers on first use. Returns null when workers are
   * unavailable (Node/vitest) or failed — the caller falls back inline.
   * The `new URL('./worker.ts', import.meta.url)` pattern lets Vite bundle
   * the worker cleanly in the consuming apps.
   */
  private ensureWorkers(): Worker[] | null {
    if (this.disposed || this.workersFailed) return null;
    if (this.workers) return this.workers;
    if (typeof Worker === 'undefined') return null;
    try {
      const count = Math.max(1, Math.min(MAX_WORKERS, this.requestedWorkers));
      const created: Worker[] = [];
      for (let i = 0; i < count; i++) {
        const worker = new Worker(new URL('./worker.ts', import.meta.url), {
          type: 'module',
        });
        worker.onmessage = (event: MessageEvent<WorkerPageResponse>) =>
          this.onWorkerMessage(event.data);
        worker.onerror = () => this.failWorkers(new Error('crawler worker error'));
        created.push(worker);
      }
      this.workers = created;
      return this.workers;
    } catch {
      this.workersFailed = true;
      return null;
    }
  }

  private onWorkerMessage(message: WorkerPageResponse): void {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.ok) {
      entry.resolve(message.result);
    } else {
      // Worker-side parse failure: reprocess inline (fidelity over speed).
      entry.resolve(this.inline.processPage(entry.html, entry.baseUrl, { enrich: entry.enrich }));
    }
  }

  /** A worker errored: terminate the pool, reprocess all pending pages
   *  inline, and serve everything inline from now on. */
  private failWorkers(_error: Error): void {
    this.workersFailed = true;
    for (const worker of this.workers ?? []) worker.terminate();
    this.workers = null;
    const stuck = [...this.pending.values()];
    this.pending.clear();
    for (const entry of stuck) {
      entry.resolve(this.inline.processPage(entry.html, entry.baseUrl, { enrich: entry.enrich }));
    }
  }

  /** Parse + hash (+ optional enrich) one page, off-thread when possible. */
  async processPage(
    html: string,
    baseUrl: string,
    opts?: ProcessPageOptions,
  ): Promise<ProcessedPage> {
    // Spike finding #2: HTML4 uppercase-attribute pages parse degraded in
    // linkedom — route them to the spec-conformant main-thread DOMParser.
    if (needsMainThreadParse(html)) {
      return this.inline.processPage(html, baseUrl, opts);
    }

    const workers = this.ensureWorkers();
    if (!workers) return this.inline.processPage(html, baseUrl, opts);

    const id = ++this.nextId;
    const worker = workers[this.roundRobin++ % workers.length]!;
    const result = await new Promise<ProcessedPage>((resolve, reject) => {
      this.pending.set(id, { id, html, baseUrl, enrich: opts?.enrich ?? false, resolve, reject });
      worker.postMessage({ id, html, baseUrl, enrich: opts?.enrich ?? false });
    });

    // Belt-and-braces (spike recommendation #3): a lang claim the worker
    // missed means an attribute was dropped — reprocess inline.
    if (langMismatch(html, result.parsed)) {
      return this.inline.processPage(html, baseUrl, opts);
    }
    return result;
  }

  /** Terminate the workers. In-flight pages are reprocessed inline. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.failWorkers(new Error('worker pool disposed'));
  }
}

/* ---------------------------------------------------------------------- */
/* The union parser — shared verbatim by the DOMParser path (inline) and   */
/* the linkedom path (worker). Spike-verified: byte-identical output on    */
/* 22/23 corpus pages (the 23rd is the uppercase-attribute fallback above).*/
/* ---------------------------------------------------------------------- */

/** Detect RSS/Atom feeds linked from a parsed HTML document. */
function detectFeeds(doc: Document, baseUrl: string): FeedLink[] {
  const feeds: FeedLink[] = [];
  const seen = new Set<string>();

  const links = doc.querySelectorAll(
    'link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"], link[rel="alternate"][type*="xml"]',
  );

  links.forEach((el) => {
    const href = el.getAttribute('href');
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (!href) return;
    try {
      const url = new URL(href, baseUrl).href;
      if (!url.startsWith('http') || seen.has(url)) return;
      seen.add(url);
      feeds.push({ url, kind: type.includes('atom') ? 'atom' : 'rss' });
    } catch {
      // Invalid URL, skip
    }
  });

  return feeds;
}

/**
 * The parser body, written against the DOM Document interface. The worker
 * passes linkedom's document (behaviorally equivalent per the fidelity
 * spike — tag names are lowercased, attribute names are the one known
 * divergence, handled by needsMainThreadParse).
 */
export function parsePageFromDocument(doc: Document, baseUrl: string): ParsedPage {
  const title =
    doc.querySelector('title')?.textContent?.trim() ??
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ??
    '';

  const description =
    doc.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ??
    doc.querySelector('meta[property="og:description"]')?.getAttribute('content')?.trim() ??
    '';

  // Representative image (SIP-01 §6: https-only, enforced at build time
  // too). og:image content is frequently relative — resolve against the
  // page URL.
  const imageRaw =
    doc.querySelector('meta[property="og:image"]')?.getAttribute('content')?.trim() ??
    doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content')?.trim() ??
    '';
  let image = '';
  if (imageRaw) {
    try {
      image = new URL(imageRaw, baseUrl).href;
    } catch {
      image = '';
    }
  }

  // Claimed publication time (SIP-01 §6 `published` tag, unix seconds).
  // Clamp defensively (SIP-01 finding C-1): a page claiming a pre-1970 date
  // yields a negative timestamp, and relays reject a negative `published`
  // tag wholesale. Drop non-positive claims HERE, before the builder.
  const publishedRaw =
    doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content')?.trim() ??
    doc.querySelector('meta[name="date"]')?.getAttribute('content')?.trim() ??
    doc.querySelector('time[datetime]')?.getAttribute('datetime')?.trim() ??
    '';
  const publishedTs = publishedRaw ? Math.floor(new Date(publishedRaw).getTime() / 1000) : NaN;
  const published = Number.isFinite(publishedTs) && publishedTs > 0 ? publishedTs : undefined;

  // RSS / Atom feeds linked from the page (discovery signal).
  const feeds = detectFeeds(doc, baseUrl);

  // Canonical URL the page claims for itself (dedup signal).
  const canonicalRaw = doc.querySelector('link[rel="canonical"]')?.getAttribute('href')?.trim() ?? '';
  let canonical = '';
  if (canonicalRaw) {
    try {
      canonical = new URL(canonicalRaw, baseUrl).href;
    } catch {
      canonical = '';
    }
  }

  // meta keywords: the site's own topic claims (source evidence).
  const keywordsRaw = doc.querySelector('meta[name="keywords"]')?.getAttribute('content') ?? '';
  const keywords = keywordsRaw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 1 && k.length < 60)
    .slice(0, 20);

  // og:type (article / website / video.* / product / …)
  const ogType =
    doc.querySelector('meta[property="og:type"]')?.getAttribute('content')?.trim().toLowerCase() ||
    undefined;

  // JSON-LD @type values (Article, BlogPosting, VideoObject, Product, …)
  const jsonLdTypes: string[] = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
    try {
      const data: unknown = JSON.parse(el.textContent ?? '');
      const collect = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(collect);
          return;
        }
        const rec = node as Record<string, unknown>;
        const t = rec['@type'];
        if (typeof t === 'string') jsonLdTypes.push(t);
        else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && jsonLdTypes.push(x));
        if (rec['@graph']) collect(rec['@graph']);
      };
      collect(data);
    } catch {
      // Malformed JSON-LD — ignore.
    }
  });

  // First headings — strong topical evidence.
  const headings: string[] = [];
  doc.querySelectorAll('h1, h2').forEach((el) => {
    if (headings.length >= 4) return;
    const t = el.textContent?.replace(/\s+/g, ' ').trim();
    if (t && t.length > 3 && t.length < 200) headings.push(t);
  });

  // Remove non-content elements
  const removeSelectors =
    'script, style, noscript, iframe, nav, footer, header, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .nav, .navbar, .sidebar, .footer, .header, .menu, .ad, .ads, .advertisement, .social-share, .comments';
  doc.querySelectorAll(removeSelectors).forEach((el) => el.remove());

  // Extract main content
  const mainContent =
    doc.querySelector('main') ??
    doc.querySelector('article') ??
    doc.querySelector('[role="main"]') ??
    doc.querySelector('.content') ??
    doc.querySelector('#content') ??
    doc.body;

  const text = mainContent?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  const language = doc.documentElement.lang?.split('-')[0] ?? 'en';

  // Extract links
  const links: string[] = [];
  doc.querySelectorAll('a[href]').forEach((el) => {
    const href = el.getAttribute('href');
    if (!href) return;
    try {
      const absoluteUrl = new URL(href, baseUrl).href;
      // Only include http(s) links, no fragments, no mailto/tel
      if (absoluteUrl.startsWith('http') && !absoluteUrl.includes('#')) {
        links.push(absoluteUrl);
      }
    } catch {
      // Invalid URL, skip
    }
  });

  return {
    title,
    description,
    image,
    published,
    feeds,
    canonical,
    keywords,
    ogType,
    jsonLdTypes: [...new Set(jsonLdTypes)],
    headings,
    text: text.slice(0, 10000), // Cap text at 10k chars for storage
    language,
    links: [...new Set(links)],
    wordCount,
  };
}

/** Parse one HTML page into structured content + discovery/classification
 *  evidence. Requires a DOM (browser or jsdom). */
export function parsePage(html: string, baseUrl: string): ParsedPage {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  return parsePageFromDocument(doc, baseUrl);
}
