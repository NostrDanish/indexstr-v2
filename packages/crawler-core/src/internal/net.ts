/**
 * net.ts — guardedFetch: THE only network egress in @sip01/crawler-core.
 *
 *                  ┌───────────────────────────────────────────┐
 *     all egress → │ net.guardedFetch*(url, opts)              │
 *                  │  1. assertPublicUrl(url)        ← guard   │
 *                  │  2. direct fetch (stream-capped, metered) │
 *                  │  3. on redirect: assertPublicUrl(         │
 *                  │       response.url) re-check    ← guard   │
 *                  │  4. proxy fallback: guard ALREADY applied │
 *                  │     to the *target* before templating     │
 *                  └───────────────────────────────────────────┘
 *
 * Robots, page, feed, sitemap, NIP-11 probe and any future path go through
 * here — nothing else in core may call fetch. The P0 ordering bug (robots
 * fetched before the page's SSRF check) is unrepresentable: robots.ts has
 * no fetch code of its own, and this module refuses private targets before
 * ANY request, direct or proxied.
 *
 * Stream-capped reads (also security): bodies are read via
 * response.body.getReader(), counting real bytes and aborting at the size
 * cap — no multi-hundred-MB main-thread allocations, and byte-accurate
 * metering for free (the meter counts EVERY byte, kept or discarded).
 *
 * Failure classification is a discriminated union: `permanent` outcomes
 * (4xx except 408/409/425/429, non-HTML, oversize, SSRF) are never retried
 * and become negative cache entries; `transient` outcomes (5xx, retryable
 * 4xx, network, timeout) are eligible for the engine's bounded retry.
 *
 * RESIDUAL RISK (documented honestly): proxied fetches resolve redirects
 * and DNS server-side; a public page redirecting to a private target is
 * followed by the proxy unchecked, and DNS rebinding is undefendable from
 * a browser. The pre-send guard (with IPv6 transition unfolding) is the
 * control for that path.
 */

import { assertPublicUrl, isPubliclyFetchable } from './guard';
import type { Meter } from './meter';

/** Default CORS proxy template ('{href}' placeholder). Host-overridable. */
export const DEFAULT_PROXY_TEMPLATE = 'https://proxy.shakespeare.diy/?url={href}';

/**
 * Honest disclosure for host UIs: when the proxy is used, the proxy
 * operator sees which URL was fetched (not who searched for it, and no
 * user identity).
 */
export const PROXY_NOTE =
  'When a site blocks direct browser access (CORS), the request is routed through a CORS proxy. The proxy operator can see which URLs are fetched.';

export type FetchOutcome =
  | {
      ok: true;
      url: string;
      finalUrl: string;
      status: number;
      contentType: string;
      /** Real bytes read off the wire (Uint8Array length). */
      bytes: number;
      body: string;
      viaProxy: boolean;
    }
  | {
      ok: false;
      kind: 'permanent';
      reason: 'http-4xx' | 'non-html' | 'oversize' | 'ssrf' | 'unsupported-scheme';
      status?: number;
    }
  | {
      ok: false;
      kind: 'transient';
      reason: 'http-5xx' | 'http-4xx-retryable' | 'network' | 'timeout';
      status?: number;
    };

/**
 * 4xx statuses that are NOT permanent: the request may succeed later, so
 * the engine's bounded transient retry applies (everything else 4xx —
 * 400/401/403/404/410/… — is a permanent negative-cache entry):
 *   408 Request Timeout        — server gave up; retry may land
 *   409 Conflict               — optimistic-concurrency / permafrost-style
 *   425 Too Early              — early-data replay protection
 *   429 Too Many Requests      — rate limit; retry after backoff
 */
export const RETRYABLE_4XX: ReadonlySet<number> = new Set([408, 409, 425, 429]);

export interface NetConfig {
  /** Injectable fetch (tests). Defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
  /** CORS proxy template with a '{href}' placeholder; empty disables. */
  proxyTemplate?: string;
  /** Byte meter — every byte read is recorded here when present. */
  meter?: Meter;
}

export interface FetchOptions {
  /** Hard byte cap on the body (stream-enforced). Default 2 MB. */
  maxBytes?: number;
  /** Allow falling back to the CORS proxy. Default true. */
  allowProxy?: boolean;
  timeoutMs?: number;
  /** Accept header for the attempt. */
  accept?: string;
}

const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const XML_ACCEPT =
  'application/rss+xml,application/atom+xml,application/xml,text/xml,text/html,*/*;q=0.8';

export class Net {
  private readonly fetchFn: typeof fetch;
  private readonly proxyTemplate?: string;
  private readonly meter?: Meter;

  constructor(config: NetConfig = {}) {
    this.fetchFn =
      config.fetchFn ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    this.proxyTemplate = config.proxyTemplate;
    this.meter = config.meter;
  }

  private proxyUrl(url: string): string | null {
    if (!this.proxyTemplate) return null;
    return this.proxyTemplate.replace('{href}', encodeURIComponent(url));
  }

  /**
   * Read a response body with a hard byte cap. Counts REAL bytes
   * (Uint8Array length) and aborts the stream the moment the cap is
   * exceeded. Returns null on oversize.
   */
  private async readCapped(
    response: Response,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ body: string; bytes: number } | null> {
    const body = response.body;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) {
            this.meter?.recordFetch(bytes);
            await reader.cancel().catch(() => {});
            return null;
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock?.();
      }
      this.meter?.recordFetch(bytes);
      return { body: text, bytes };
    }

    // Fallback for fetch mocks without a streaming body.
    const text = await response.text();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const bytes = new TextEncoder().encode(text).byteLength;
    this.meter?.recordFetch(bytes);
    if (bytes > maxBytes) return null;
    return { body: text, bytes };
  }

  /** Single fetch attempt. Never throws for HTTP/content failures. */
  private async attempt(
    requestUrl: string,
    targetUrl: string,
    options: Required<FetchOptions>,
    direct: boolean,
  ): Promise<FetchOutcome> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await this.fetchFn(requestUrl, {
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow',
        signal: controller.signal,
        headers: { Accept: options.accept },
      });

      if (!response.ok) {
        if (response.status >= 500) {
          return { ok: false, kind: 'transient', reason: 'http-5xx', status: response.status };
        }
        if (RETRYABLE_4XX.has(response.status)) {
          return {
            ok: false,
            kind: 'transient',
            reason: 'http-4xx-retryable',
            status: response.status,
          };
        }
        return { ok: false, kind: 'permanent', reason: 'http-4xx', status: response.status };
      }

      // Redirect → private target: discard. This re-validation covers the
      // DIRECT path; on the proxied path response.url is the proxy itself
      // and server-side redirects are opaque to us (see header RESIDUAL RISK).
      const finalUrl = response.url || requestUrl;
      if (direct && finalUrl !== requestUrl && !isPubliclyFetchable(finalUrl)) {
        return { ok: false, kind: 'permanent', reason: 'ssrf' };
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > options.maxBytes) {
        return { ok: false, kind: 'permanent', reason: 'oversize' };
      }

      const read = await this.readCapped(response, options.maxBytes, controller.signal);
      if (!read) return { ok: false, kind: 'permanent', reason: 'oversize' };

      const contentType = response.headers.get('content-type') ?? '';
      return {
        ok: true,
        url: targetUrl,
        finalUrl: direct ? finalUrl : targetUrl,
        status: response.status,
        contentType,
        bytes: read.bytes,
        body: read.body,
        viaProxy: !direct,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { ok: false, kind: 'transient', reason: 'timeout' };
      }
      return { ok: false, kind: 'transient', reason: 'network' };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * The choke point. Every fetch in core starts here.
   *
   * Order: guard the TARGET (before any request, direct or proxied) →
   * direct attempt → transient network failure falls back to the proxy
   * (the guard already vetted the target before templating).
   */
  async guardedFetch(url: string, options: FetchOptions = {}): Promise<FetchOutcome> {
    // SSRF admission — BEFORE any request exists. Also covers non-http(s).
    try {
      assertPublicUrl(url);
    } catch {
      return { ok: false, kind: 'permanent', reason: 'ssrf' };
    }

    const opts: Required<FetchOptions> = {
      maxBytes: options.maxBytes ?? 2048 * 1024,
      allowProxy: options.allowProxy ?? true,
      timeoutMs: options.timeoutMs ?? 15000,
      accept: options.accept ?? HTML_ACCEPT,
    };

    const direct = await this.attempt(url, url, opts, true);
    if (direct.ok) return direct;

    // Proxy fallback only for network-level failures (almost always CORS).
    // Timeouts and permanent failures are not worth re-trying via proxy.
    if (direct.kind === 'transient' && direct.reason === 'network' && opts.allowProxy) {
      const proxied = this.proxyUrl(url);
      if (proxied) return this.attempt(proxied, url, opts, false);
    }
    return direct;
  }

  /**
   * Fetch an HTML page: guardedFetch + content-type check + markup sniff.
   * Non-HTML payloads are a permanent refusal, never retried.
   */
  async guardedFetchPage(url: string, options: FetchOptions = {}): Promise<FetchOutcome> {
    const outcome = await this.guardedFetch(url, { ...options, accept: HTML_ACCEPT });
    if (!outcome.ok) return outcome;

    // Proxies sometimes omit/rewrite content-type. Accept empty and sniff.
    const ct = outcome.contentType;
    const looksHtml =
      ct === '' ||
      ct.includes('text/html') ||
      ct.includes('application/xhtml') ||
      ct.includes('text/plain');
    if (!looksHtml) return { ok: false, kind: 'permanent', reason: 'non-html' };

    if (!/<\s*(!doctype|html|head|body|title|meta|div|a|p)\b/i.test(outcome.body.slice(0, 4000))) {
      return { ok: false, kind: 'permanent', reason: 'non-html' };
    }
    return outcome;
  }

  /**
   * Fetch an XML-ish document (RSS/Atom feed, sitemap) — same guard +
   * direct-then-proxy strategy, with an XML Accept header.
   */
  async guardedFetchXml(url: string, options: FetchOptions = {}): Promise<FetchOutcome> {
    return this.guardedFetch(url, {
      maxBytes: 1024 * 1024,
      timeoutMs: 12000,
      ...options,
      accept: XML_ACCEPT,
    });
  }

  /**
   * Fetch a small text document (robots.txt, NIP-11 relay document) with
   * a caller-supplied Accept header. No content sniffing.
   */
  async guardedFetchText(url: string, options: FetchOptions = {}): Promise<FetchOutcome> {
    return this.guardedFetch(url, {
      maxBytes: 512 * 1024,
      timeoutMs: 8000,
      ...options,
    });
  }
}
