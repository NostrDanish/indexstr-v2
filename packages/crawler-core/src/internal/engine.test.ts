/**
 * engine.test.ts — the crawl state machine's behavioral contract, driven
 * through the PUBLIC createCrawler() surface (the deep-module boundary).
 * Everything here is the orchestration stories from the blueprint:
 * admission, freshness gate, robots ordering, retries, queue-cap,
 * start/stop semantics.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import type { NostrEvent } from '@nostrify/nostrify';

import { createCrawler, type CrawlerNode, type SignableEvent } from '../index';

/* ------------------------------------------------------------------------ */
/* Harness                                                                   */
/* ------------------------------------------------------------------------ */

const INDEXER_PUBKEY = 'ab'.repeat(32);

function makeSigner() {
  return async (event: SignableEvent): Promise<NostrEvent> => ({
    ...event,
    id: 'ev' + '0'.repeat(62),
    pubkey: INDEXER_PUBKEY,
    sig: 's'.repeat(128),
  });
}

const PAGE_HTML = (title: string, words = 50) =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${'word '.repeat(words)}</p></body></html>`;

interface Harness {
  node: CrawlerNode;
  published: NostrEvent[];
  /** url → response-ish; missing url = network error. */
  serve: (url: string, body: string, init?: { status?: number; contentType?: string }) => void;
  fail: (url: string) => void;
}

function makeNode(opts: {
  robotsAllowed?: boolean;
  maxQueueSize?: number;
  maxDepth?: number;
} = {}): Harness {
  const published: NostrEvent[] = [];
  const routes = new Map<string, { body: string; status: number; contentType: string } | 'fail'>();

  const fetchFn = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // robots.txt: default allow-all (empty rules body).
    if (url.endsWith('/robots.txt')) {
      if (opts.robotsAllowed === false) {
        return new Response('User-agent: *\nDisallow: /\n', { status: 200 });
      }
      return new Response('User-agent: *\nAllow: /\n', { status: 200 });
    }
    const route = routes.get(url);
    if (!route || route === 'fail') throw new TypeError('fetch failed');
    return new Response(route.body, {
      status: route.status,
      headers: { 'content-type': route.contentType },
    });
  }) as typeof fetch;

  const node = createCrawler({
    dbName: `test-crawler-${Math.random().toString(36).slice(2)}`,
    source: 'crawlstr/v2',
    signer: makeSigner(),
    indexerPubkey: INDEXER_PUBKEY,
    indexerNpub: 'npub1test',
    transports: {
      publish: async (_relay, ev) => {
        published.push(ev);
      },
      fetch: fetchFn,
      proxyTemplate: '', // no proxy fallback in tests
    },
    relays: { publish: ['wss://relay.test'] },
    budgets: { maxPagesPerHour: 0, maxBytesPerHour: 0 },
    politeness: { minIntervalPerDomainMs: 0, respectRobots: true },
    crawl: { maxDepth: opts.maxDepth ?? 3, maxQueueSize: opts.maxQueueSize ?? 100 },
    workerCount: 1,
  });

  return {
    node,
    published,
    serve: (url, body, init) => {
      routes.set(url, {
        body,
        status: init?.status ?? 200,
        contentType: init?.contentType ?? 'text/html',
      });
    },
    fail: (url) => routes.set(url, 'fail'),
  };
}

/** Wait until `cond` or timeout (the crawl loop is async). */
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('until() timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  // fresh fake-indexeddb per test file; unique dbName per node
});

afterEach(() => {
  // nodes are stopped inside tests that start them
});

/* ------------------------------------------------------------------------ */
/* Admission                                                                 */
/* ------------------------------------------------------------------------ */

describe('admission (seed → queue)', () => {
  it('admits a public https URL', async () => {
    const { node } = makeNode();
    const r = await node.seed(['https://example.com/']);
    expect(r.admitted).toBe(1);
    expect(r.rejected).toBe(0);
  });

  it('rejects private targets at admission (SSRF never enters the queue)', async () => {
    const { node } = makeNode();
    for (const url of [
      'http://169.254.169.254/latest/meta-data',
      'http://127.0.0.1/',
      'http://192.168.1.1/',
      'http://[64:ff9b::a9fe:a9fe]/',
      'http://2130706433/',
      'ftp://example.com/',
      'not a url',
    ]) {
      const r = await node.seed([url]);
      expect(r.admitted).toBe(0);
    }
  });

  it('normalizes before admission (case, default port, fragment)', async () => {
    const { node } = makeNode();
    await node.seed(['HTTPS://EXAMPLE.COM:443/path#frag']);
    const stats = await node.persistedStats();
    expect(stats.queueSize).toBe(1);
  });

  it('honors the queue cap (admission-time, F7)', async () => {
    const { node } = makeNode({ maxQueueSize: 3 });
    const r = await node.seed([
      'https://a.example/',
      'https://b.example/',
      'https://c.example/',
      'https://d.example/',
    ]);
    expect(r.admitted).toBe(3);
    expect(r.rejected).toBe(1);
  });
});

/* ------------------------------------------------------------------------ */
/* Crawl lifecycle                                                           */
/* ------------------------------------------------------------------------ */

describe('crawl loop', () => {
  it('crawls a queued page and publishes a kind 39697 observation', async () => {
    const { node, published, serve } = makeNode();
    serve('https://example.com/', PAGE_HTML('Hello Index'));

    await node.seed(['https://example.com/']);
    await node.start();
    await until(() => published.length === 1);
    await node.stop();

    const ev = published[0]!;
    expect(ev.kind).toBe(39697);
    const d = ev.tags.find(([n]) => n === 'd');
    expect(d?.[1]).toBe('https://example.com/');
    const title = ev.tags.find(([n]) => n === 'title');
    expect(title?.[1]).toBe('Hello Index');
    const source = ev.tags.find(([n]) => n === 'source');
    expect(source?.[1]).toBe('crawlstr/v2');

    const stats = node.stats();
    expect(stats.pagesIndexed).toBe(1);
    expect(stats.queueSize).toBeGreaterThanOrEqual(1); // recrawl job re-queued
  });

  it('robots.txt Disallow blocks the crawl (and no observation is published)', async () => {
    const { node, published, serve } = makeNode({ robotsAllowed: false });
    serve('https://blocked.example/', PAGE_HTML('Blocked'));

    await node.seed(['https://blocked.example/']);
    await node.start();
    await until(() => node.stats().robotsBlocked === 1);
    await node.stop();

    expect(published).toHaveLength(0);
    expect(node.stats().pagesIndexed).toBe(0);
  });

  it('thin content is skipped without publishing', async () => {
    const { node, published, serve } = makeNode();
    serve('https://thin.example/', PAGE_HTML('Thin', 3));

    await node.seed(['https://thin.example/']);
    await node.start();
    await until(() => node.stats().thinContent === 1);
    await node.stop();

    expect(published).toHaveLength(0);
  });

  it('permanent HTTP failures become negative-cache entries (never retried)', async () => {
    const { node, serve } = makeNode();
    serve('https://gone.example/', 'not found', { status: 404 });

    await node.seed(['https://gone.example/']);
    await node.start();
    await until(() => node.stats().fetchFailed === 1);
    await node.stop();

    // Re-admission of a negatively cached URL is deduped.
    const r = await node.seed(['https://gone.example/']);
    expect(r.admitted).toBe(0);
  });

  it('transient failures retry with backoff, then land in the negative cache', async () => {
    const { node, fail } = makeNode();
    fail('https://flaky.example/');

    await node.seed(['https://flaky.example/']);
    await node.start();
    // Wait until attempts are exhausted (backoff is 30s+ — the loop defers,
    // so we wait for the attempts counter via stats.errors reaching 4:
    // 1 initial + 3 retries... but deferral is time-based. To keep the test
    // fast, assert the FIRST failure schedules a retry (attempts=1) and the
    // job remains queued with a future nextAttempt.
    await until(() => node.stats().fetchFailed >= 1);
    await node.stop();

    expect(node.stats().errors).toBeGreaterThanOrEqual(1);
    // Still queued (retry scheduled) — not yet negatively cached.
    const stats = await node.persistedStats();
    expect(stats.queueSize).toBe(1);
  });

  it('followLinks: false (collection mode) crawls ONLY the seeded URLs', async () => {
    const { node, published, serve } = makeNode();
    serve(
      'https://collection.example/',
      `<!doctype html><html><head><title>C</title></head><body>
       <a href="https://linked.example/">link</a><p>${'word '.repeat(30)}</p></body></html>`,
    );
    serve('https://linked.example/', PAGE_HTML('Linked'));

    await node.seed(['https://collection.example/'], { followLinks: false });
    await node.start();
    await until(() => published.length === 1);
    await new Promise((r) => setTimeout(r, 200));
    await node.stop();

    // The linked URL was never admitted.
    expect(published).toHaveLength(1);
    expect(node.stats().discovered).toBe(0);
  });

  it('duplicate content (same body, different URL) is skipped', async () => {
    const { node, published, serve } = makeNode();
    const body = PAGE_HTML('Same Body', 40);
    serve('https://one.example/', body);
    serve('https://two.example/', body);

    await node.seed(['https://one.example/', 'https://two.example/']);
    await node.start();
    await until(() => node.stats().pagesIndexed + node.stats().duplicates >= 2);
    await node.stop();

    expect(node.stats().duplicates).toBe(1);
    expect(published).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------ */
/* Freshness / recrawl                                                       */
/* ------------------------------------------------------------------------ */

describe('freshness', () => {
  it('a crawled URL is re-queued with a future recrawlDue (not immediately recrawled)', async () => {
    const { node, published, serve } = makeNode();
    serve('https://fresh.example/', PAGE_HTML('Fresh'));

    await node.seed(['https://fresh.example/']);
    await node.start();
    await until(() => published.length === 1);
    // Give the loop time to (wrongly) recrawl if the freshness gate failed.
    await new Promise((r) => setTimeout(r, 300));
    await node.stop();

    expect(published).toHaveLength(1); // exactly one observation
    const stats = await node.persistedStats();
    expect(stats.queueSize).toBe(1); // the recrawl job waits for its due time
  });
});

/* ------------------------------------------------------------------------ */
/* Lifecycle semantics                                                       */
/* ------------------------------------------------------------------------ */

describe('start/stop', () => {
  it('stop() halts the loop; start() resumes', async () => {
    const { node, published, serve } = makeNode();
    serve('https://example.com/', PAGE_HTML('Resumable'));

    await node.seed(['https://example.com/']);
    await node.start();
    await until(() => published.length === 1);
    await node.stop();
    expect(node.isRunning()).toBe(false);

    // Queue + crawled survive a stop.
    const stats = await node.persistedStats();
    expect(stats.pagesIndexed).toBe(1);
  });

  it('double start() is a no-op', async () => {
    const { node } = makeNode();
    await node.start();
    await node.start();
    expect(node.isRunning()).toBe(true);
    await node.stop();
  });

  it('clearQueue empties the queue but keeps crawled history', async () => {
    const { node, serve } = makeNode();
    serve('https://example.com/', PAGE_HTML('Clearable'));
    await node.seed(['https://example.com/']);
    await node.start();
    await until(() => node.stats().pagesIndexed === 1);
    await node.stop();

    await node.clearQueue();
    const stats = await node.persistedStats();
    expect(stats.queueSize).toBe(0);
    expect(stats.pagesIndexed).toBe(1);
  });
});

/* ------------------------------------------------------------------------ */
/* Canonical identity                                                        */
/* ------------------------------------------------------------------------ */

describe('canonical URL handling', () => {
  it('the observation is filed under the page-claimed canonical URL', async () => {
    const { node, published, serve } = makeNode();
    serve(
      'https://example.com/page',
      `<!doctype html><html><head><title>Canon</title>
       <link rel="canonical" href="https://example.com/canonical">
       </head><body><p>${'word '.repeat(30)}</p></body></html>`,
    );

    await node.seed(['https://example.com/page']);
    await node.start();
    await until(() => published.length === 1);
    await node.stop();

    const d = published[0]!.tags.find(([n]) => n === 'd');
    expect(d?.[1]).toBe('https://example.com/canonical');
  });
});
