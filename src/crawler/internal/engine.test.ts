/**
 * engine.test.ts — UNION port of both apps' engine tests, adapted to the
 * deep module's dependency-injected seams (no module mocks needed: fetch,
 * signer, publish and storage are all host-injected; storage runs on
 * fake-indexeddb).
 *
 * These tests encode the P0 security properties:
 *   F1  SSRF admission check runs at enqueue AND at crawl start BEFORE
 *       robots — private targets cause ZERO requests of any kind.
 *   F6  Intake dedup happens BEFORE budget charging (replay griefing fix).
 *   #1  Non-public seed URLs never enter the queue.
 */
import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { Engine } from './engine';
import {
  createIdbStorage,
  NEGATIVE_CACHE_TTL_MS,
  type CrawlerStorage,
} from './storage';
import { WEB_INDEX_KIND } from '@sip01/protocol';
import type { CrawlJob, ParsedPage, ResolvedConfig } from './types';

let dbCounter = 0;

const fakeSigner = async (event: {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}): Promise<NostrEvent> => ({
  id: Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64),
  pubkey: 'ab'.repeat(32),
  sig: 'b'.repeat(128),
  ...event,
});

interface Harness {
  engine: Engine;
  storage: CrawlerStorage;
  fetchMock: ReturnType<typeof vi.fn>;
  published: NostrEvent[];
  intakeEvents: NostrEvent[];
}

function makeHarness(overrides: {
  respectRobots?: boolean;
  intake?: boolean;
  sharding?: boolean;
  clock?: () => number;
  maxQueueSize?: number;
  parallelism?: number;
  minIntervalPerDomainMs?: number;
  maxPagesPerHour?: number;
  publish?: (relayUrl: string, ev: NostrEvent) => Promise<void>;
  signer?: typeof fakeSigner;
} = {}): Harness {
  const fetchMock = vi.fn(async () => new Response('<html><title>x</title></html>', { status: 200 }));
  const published: NostrEvent[] = [];
  const intakeEvents: NostrEvent[] = [];
  const storage = createIdbStorage(`crawler-core-engine-test-${++dbCounter}`);

  const config: ResolvedConfig = {
    dbName: 'test',
    source: 'test/1',
    nodeVersion: '2',
    signer: overrides.signer ?? fakeSigner,
    indexerPubkey: 'ab'.repeat(32),
    indexerNpub: 'npub1test',
    publish:
      overrides.publish ??
      (async (_url, ev) => {
        published.push(ev);
      }),
    intakeQuery: async () => intakeEvents,
    fetchFn: fetchMock as unknown as typeof fetch,
    clock: overrides.clock ?? Date.now,
    relays: { publish: ['wss://relay.example'] },
    budgets: {
      maxPagesPerHour: overrides.maxPagesPerHour ?? 0,
      maxBytesPerHour: 0,
      maxPageSizeKB: 2048,
    },
    politeness: {
      parallelism: overrides.parallelism ?? 1,
      minIntervalPerDomainMs: overrides.minIntervalPerDomainMs ?? 0,
      maxCrawlDelayMs: 60_000,
      respectRobots: overrides.respectRobots ?? true,
    },
    modules: {
      intake: { enabled: overrides.intake ?? false, intervalMs: 120_000 },
      enrich: { enabled: false },
      discovery: { feeds: false, sitemaps: false },
      heartbeat: { enabled: false, intervalMs: 600_000 },
      traps: { enabled: true },
      sharding: { enabled: overrides.sharding ?? false },
    },
    crawl: { maxDepth: 3, ecoMode: true, maxQueueSize: overrides.maxQueueSize ?? 150_000 },
    workerCount: 1, // tests: inline processor (no Worker in jsdom anyway)
  };

  return { engine: new Engine(config, storage), storage, fetchMock, published, intakeEvents };
}

/** Structural cast to drive internals directly (ordering tests assert
 *  ADMISSION and ORDERING, not parsing). */
interface EngineInternals {
  crawlUrl(job: CrawlJob): Promise<{ job: CrawlJob; parsed: ParsedPage } | null>;
  /** Post-crawl work (discovery + link following) — the slot runner calls
   *  this AFTER releasing the fetch slot. */
  postCrawl(job: CrawlJob, parsed: ParsedPage): Promise<void>;
  handleFetchFailure(
    job: CrawlJob,
    outcome: { kind: 'permanent' | 'transient'; reason: string; status?: number },
    now: number,
  ): Promise<void>;
  running: boolean;
  intake: { sybilGuard: { allow(pubkey: string): boolean } } | null;
}
const internals = (engine: Engine): EngineInternals => engine as unknown as EngineInternals;

function makeJob(url: string): CrawlJob {
  return { url, priority: 1, depth: 0, attempts: 0, followLinks: false };
}

function makeEvent(pubkey: string, url: string, id: string): NostrEvent {
  return {
    id,
    pubkey,
    kind: WEB_INDEX_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', `widx:${id}`],
      ['u', url],
    ],
    content: '',
    sig: '00',
  };
}

describe('crawlUrl SSRF ordering (F1 — the P0 ordering fix)', () => {
  it('private-host job issues NO fetch — not robots, not the page', async () => {
    const { engine, storage, fetchMock } = makeHarness();
    await internals(engine).crawlUrl(makeJob('http://169.254.169.254/latest/meta-data'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await storage.isQueued('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(engine.getStats().ssrfBlocked).toBe(1);
    expect(engine.getStats().skipped).toBe(1);
  });

  it('IPv6-bypass private job is refused before any request too', async () => {
    const { engine, fetchMock } = makeHarness();
    await internals(engine).crawlUrl(makeJob('http://[64:ff9b::a9fe:a9fe]/x'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(engine.getStats().ssrfBlocked).toBe(1);
  });

  it('drops a non-public job already in the queue instead of fetching it', async () => {
    // Simulates a queue entry written before the admission gate existed.
    const { engine, storage, fetchMock } = makeHarness({ respectRobots: false });
    await storage.putJob({ url: 'http://10.0.0.9/internal', priority: 1, depth: 0, attempts: 0 });
    expect(await storage.queueSize()).toBe(1);

    await internals(engine).crawlUrl(makeJob('http://10.0.0.9/internal'));

    expect(await storage.queueSize()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(engine.getStats().skipped).toBe(1);
  });

  it('public job still checks robots BEFORE fetching the page', async () => {
    const { engine, fetchMock } = makeHarness();
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/robots.txt')) return new Response('', { status: 404 });
      return new Response('server error', { status: 500 }); // stop after the fetch
    });

    await internals(engine).crawlUrl(makeJob('https://example.com/article'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = String(fetchMock.mock.calls[0]![0]);
    const second = String(fetchMock.mock.calls[1]![0]);
    expect(first).toBe('https://example.com/robots.txt');
    expect(second).toBe('https://example.com/article');
    expect(engine.getStats().ssrfBlocked).toBe(0);
  });
});

describe('engine queue admission (audit finding #1)', () => {
  it('refuses non-public seed URLs — they never enter the queue', async () => {
    const { engine, storage } = makeHarness();
    const { admitted, rejected } = await engine.seed([
      'http://169.254.169.254/latest/meta-data',
      'http://127.0.0.1/admin',
      'http://192.168.1.1/',
      'http://localhost:3000/x',
    ]);
    expect(admitted).toBe(0);
    expect(rejected).toBe(4);
    expect(await storage.queueSize()).toBe(0);
    expect(engine.getStats().ssrfBlocked).toBe(4);
  });

  it('accepts a normal public seed URL (normalized)', async () => {
    const { engine, storage } = makeHarness();
    const { admitted } = await engine.seed(['https://engine-test-example.com/']);
    expect(admitted).toBe(1);
    expect(await storage.queueSize()).toBe(1);
  });

  it('seed defaults to followLinks:true (manual seeds self-expand)', async () => {
    const { engine, storage } = makeHarness();
    await engine.seed(['https://engine-test-example.com/']);
    const job = await storage.nextJob();
    expect(job?.followLinks).toBe(true);
  });

  it('seed followLinks:false stores non-expanding jobs (curated collections)', async () => {
    const { engine, storage } = makeHarness();
    await engine.seed(['https://engine-test-example.com/collection-item'], {
      priority: 0.9,
      followLinks: false,
    });
    const job = await storage.nextJob();
    expect(job?.followLinks).toBe(false);
    expect(job?.priority).toBe(0.9);
  });
});

describe('network intake SSRF admission (F1)', () => {
  beforeEach(() => {});

  it('private-host observation is rejected at admission, never queued', async () => {
    const { engine, storage, fetchMock, intakeEvents } = makeHarness({ intake: true });
    const url = 'http://169.254.169.254/latest/meta-data';
    intakeEvents.push(makeEvent('aa'.repeat(32), url, '11'.repeat(32)));

    internals(engine).running = true;
    await engine.networkIntake();

    expect(await storage.queueSize()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(engine.getStats().intakeRejected).toBe(1);
    expect(engine.getStats().ssrfBlocked).toBe(1);
  });

  it('public observation is admitted and queued', async () => {
    const { engine, storage, intakeEvents } = makeHarness({ intake: true });
    intakeEvents.push(makeEvent('bb'.repeat(32), 'https://example.com/interesting', '22'.repeat(32)));

    internals(engine).running = true;
    await engine.networkIntake();

    expect(await storage.isQueued('https://example.com/interesting')).toBe(true);
    expect(engine.getStats().networkIntake).toBe(1);
  });
});

describe('queue-cap consistency (F7 — MAX_QUEUE_SIZE at EVERY admission path)', () => {
  it('admit() itself refuses at the cap', async () => {
    const { engine, storage } = makeHarness({ maxQueueSize: 2 });
    expect(await engine.admit('https://cap.example/a', { priority: 1 })).toBe('queued');
    expect(await engine.admit('https://cap.example/b', { priority: 1 })).toBe('queued');
    expect(await engine.admit('https://cap.example/c', { priority: 1 })).toBe('rejected');
    expect(await storage.queueSize()).toBe(2);
  });

  it('path 1 — seeds: seed() stops admitting at the cap', async () => {
    const { engine, storage } = makeHarness({ maxQueueSize: 3 });
    const { admitted, rejected } = await engine.seed([
      'https://cap.example/s1',
      'https://cap.example/s2',
      'https://cap.example/s3',
      'https://cap.example/s4',
      'https://cap.example/s5',
    ]);
    expect(admitted).toBe(3);
    expect(rejected).toBe(2);
    expect(await storage.queueSize()).toBe(3);
  });

  it('path 2 — collections (seed with followLinks:false): same cap, same path', async () => {
    const { engine, storage } = makeHarness({ maxQueueSize: 2 });
    const { admitted, rejected } = await engine.seed(
      ['https://cap.example/c1', 'https://cap.example/c2', 'https://cap.example/c3'],
      { followLinks: false }, // the collection IS the crawl plan
    );
    expect(admitted).toBe(2);
    expect(rejected).toBe(1);
    expect(await storage.queueSize()).toBe(2);
    const job = await storage.nextJob();
    expect(job?.followLinks).toBe(false);
  });

  it('path 3 — link discovery: a crawled page admits ZERO links at the cap', async () => {
    const now = 10_000_000_000;
    const { engine, storage, fetchMock } = makeHarness({
      respectRobots: false,
      clock: () => now,
      maxQueueSize: 1,
    });
    const page = `<!doctype html><html><head><title>cap test</title></head><body>
      <p>${'word '.repeat(30)}</p>
      <a href="https://links.example.com/one">one</a>
      <a href="https://links.example.com/two">two</a>
    </body></html>`;
    fetchMock.mockResolvedValue(
      new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }),
    );

    const job = { ...makeJob('https://cap.example/page'), followLinks: true };
    await storage.putJob(job); // queue now AT the cap (1/1)
    const post = await internals(engine).crawlUrl(job);
    expect(post).not.toBeNull();
    await internals(engine).postCrawl(post!.job, post!.parsed);

    // After the crawl the queue holds exactly the recrawl re-enqueue — the
    // two discovered links were refused by the batch's cap headroom check.
    expect(await storage.queueSize()).toBe(1);
    expect(await storage.isQueued('https://links.example.com/one')).toBe(false);
    expect(await storage.isQueued('https://links.example.com/two')).toBe(false);
    expect(engine.getStats().discovered).toBe(0);
    expect(engine.getStats().pagesIndexed).toBe(1); // the page itself worked
  });

  it('path 4 — network intake: no polls at the cap, per-URL cap mid-poll', async () => {
    const { engine, storage, intakeEvents } = makeHarness({ intake: true, maxQueueSize: 2 });
    await storage.putJob({
      url: 'https://cap.example/preexisting',
      priority: 0.5,
      depth: 0,
      attempts: 0,
    });
    for (let i = 0; i < 5; i++) {
      intakeEvents.push(
        makeEvent('dd'.repeat(32), `https://cap.example/intake-${i}`, `${i}`.padStart(4, '0').repeat(16)),
      );
    }

    internals(engine).running = true;
    await engine.networkIntake();

    // Exactly ONE intake URL fit under the cap; the rest hit admit()'s
    // queue-cap check.
    expect(await storage.queueSize()).toBe(2);
    expect(engine.getStats().networkIntake).toBe(1);

    // At the cap the poll is skipped entirely (no relay query burn).
    intakeEvents.length = 0;
    await engine.networkIntake();
    expect(engine.getStats().networkIntake).toBe(1);
  });
});

describe('fetch-failure policy (audit #8 — permanent vs transient)', () => {
  const now = 10_000_000_000;

  it('permanent failure: ZERO retries — negative-cached and dequeued immediately', async () => {
    const { engine, storage } = makeHarness({ clock: () => now });
    const job = makeJob('https://example.com/gone');
    await storage.putJob(job);

    await internals(engine).handleFetchFailure(
      job,
      { kind: 'permanent', reason: 'http-4xx', status: 404 },
      now,
    );

    expect(job.attempts).toBe(0); // never retried
    expect(job.nextAttempt).toBeUndefined();
    expect(await storage.isQueued(job.url)).toBe(false);
    expect((await storage.getCrawled(job.url))?.status).toBe('failed');
    expect(engine.getStats().fetchFailed).toBe(1);
    expect(engine.getStats().errors).toBe(0); // permanents aren't errors
  });

  it('transient failure: exactly 3 retries, then the negative cache', async () => {
    const { engine, storage } = makeHarness({ clock: () => now });
    const job = makeJob('https://example.com/flaky');
    await storage.putJob(job);
    const outcome = { kind: 'transient' as const, reason: 'http-5xx', status: 503 };

    for (let retry = 1; retry <= 3; retry++) {
      await internals(engine).handleFetchFailure(job, outcome, now);
      expect(job.attempts).toBe(retry);
      expect(await storage.isQueued(job.url)).toBe(true); // still queued
      expect(job.nextAttempt).toBeGreaterThan(now); // scheduled, not spinning
      expect(await storage.getCrawled(job.url)).toBeUndefined(); // not failed yet
    }

    // The 4th failure exhausts the budget.
    await internals(engine).handleFetchFailure(job, outcome, now);
    expect(await storage.isQueued(job.url)).toBe(false);
    expect((await storage.getCrawled(job.url))?.status).toBe('failed');
    expect(engine.getStats().fetchFailed).toBe(4);
  });

  it('backoff per retry: 30s→2m→8m jittered band, and a backed-off job cannot spin the loop', async () => {
    // nextJob() readiness compares against the REAL clock, so this test
    // runs on real time (the backoff must be genuinely in the future).
    const now = Date.now();
    const { engine, storage } = makeHarness({ clock: () => now });
    const job = makeJob('https://example.com/flaky');
    await storage.putJob(job);
    const outcome = { kind: 'transient' as const, reason: 'http-5xx', status: 503 };

    const bands: Array<[number, number]> = [
      [22_500, 37_500], // attempt 1: 30 s ±25%
      [90_000, 150_000], // attempt 2: 2 m ±25%
      [360_000, 600_000], // attempt 3: 8 m ±25%
    ];
    for (const [min, max] of bands) {
      await internals(engine).handleFetchFailure(job, outcome, now);
      const delay = job.nextAttempt! - now;
      expect(delay).toBeGreaterThanOrEqual(min);
      expect(delay).toBeLessThan(max);
      // The queue's nextJob cursor skips future-dated jobs: with this the
      // only job, the crawl loop finds NOTHING to do until the backoff
      // elapses — it sleeps instead of spinning.
      expect(await storage.nextJob()).toBeNull();
    }
  });

  it('a retryable 4xx (429) end-to-end: re-queued, not negative-cached', async () => {
    const { engine, storage, fetchMock } = makeHarness({
      respectRobots: false,
      clock: () => now,
    });
    fetchMock.mockResolvedValue(new Response('slow down', { status: 429 }));

    await internals(engine).crawlUrl(makeJob('https://example.com/ratelimited'));

    expect(await storage.isQueued('https://example.com/ratelimited')).toBe(true);
    expect(await storage.getCrawled('https://example.com/ratelimited')).toBeUndefined();
  });

  it('a plain 404 end-to-end: negative-cached on the FIRST failure', async () => {
    const { engine, storage, fetchMock } = makeHarness({
      respectRobots: false,
      clock: () => now,
    });
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));

    await internals(engine).crawlUrl(makeJob('https://example.com/missing'));

    expect(await storage.isQueued('https://example.com/missing')).toBe(false);
    expect((await storage.getCrawled('https://example.com/missing'))?.status).toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(1); // one request, zero retries
  });
});

describe('negative-cache TTL (permanent failures are retried eventually)', () => {
  it('admit() blocks a fresh negative, re-admits an expired one (fake clock)', async () => {
    let now = 10_000_000_000;
    const { engine, storage } = makeHarness({ clock: () => now });
    await storage.markCrawled('https://neg.example/gone', '', '', {
      status: 'failed',
      at: now,
    });

    expect(await engine.admit('https://neg.example/gone', { priority: 1 })).toBe('duplicate');
    expect(await storage.queueSize()).toBe(0);

    // 7 days + 1 ms later the negative has expired: re-admissible even
    // before any sweep runs.
    now += NEGATIVE_CACHE_TTL_MS + 1;
    expect(await engine.admit('https://neg.example/gone', { priority: 1 })).toBe('queued');
    expect(await storage.isQueued('https://neg.example/gone')).toBe(true);
  });

  it('runMaintenance sweeps expired negatives (fake clock)', async () => {
    let now = 10_000_000_000;
    const { engine, storage } = makeHarness({ clock: () => now });
    await storage.markCrawled('https://neg.example/old', '', '', {
      status: 'failed',
      at: now - NEGATIVE_CACHE_TTL_MS - 1,
    });
    await storage.markCrawled('https://neg.example/fresh', '', '', {
      status: 'failed',
      at: now,
    });
    await storage.markCrawled('https://neg.example/ok', 'sha256:x', 't', {
      status: 'fetched',
      at: now - NEGATIVE_CACHE_TTL_MS - 1,
    });

    const result = await engine.runMaintenance();
    expect(result.expiredFailures).toBe(1);
    expect(await storage.getCrawled('https://neg.example/old')).toBeUndefined();
    expect(await storage.getCrawled('https://neg.example/fresh')).toBeDefined();
    expect(await storage.getCrawled('https://neg.example/ok')).toBeDefined();

    // Advancing the fake clock past the TTL expires the fresh one too.
    now += NEGATIVE_CACHE_TTL_MS + 1;
    const second = await engine.runMaintenance();
    expect(second.expiredFailures).toBe(1);
    expect(await storage.getCrawled('https://neg.example/fresh')).toBeUndefined();
  });
});

describe('parallel slot scheduler (P3, blueprint §3.1)', () => {
  /** Poll until `cond` holds or the timeout expires. */
  async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!(await cond())) throw new Error('waitFor: timed out');
  }

  /** Unique content per page — identical bodies would collapse into ONE
   *  crawled record via the duplicate-content check. */
  const page = (marker: string): string =>
    `<!doctype html><html><head><title>parallel test ${marker}</title></head><body>
    <p>${'word '.repeat(30)} ${marker}</p></body></html>`;
  const PAGE = page('shared');

  it('invariant (i) end-to-end: ≤1 concurrent request per domain with 4 slots — and slots do run in parallel', { timeout: 30_000 }, async () => {
    const { engine, storage, fetchMock } = makeHarness({
      respectRobots: false,
      parallelism: 4,
      minIntervalPerDomainMs: 30,
    });
    const perHost = new Map<string, number>();
    const maxPerHost = new Map<string, number>();
    let inFlightTotal = 0;
    let maxInFlightTotal = 0;

    fetchMock.mockImplementation(async (input: unknown) => {
      const host = new URL(String(input)).hostname;
      const now = (perHost.get(host) ?? 0) + 1;
      perHost.set(host, now);
      maxPerHost.set(host, Math.max(maxPerHost.get(host) ?? 0, now));
      inFlightTotal++;
      maxInFlightTotal = Math.max(maxInFlightTotal, inFlightTotal);
      const stream = new ReadableStream({
        async start(controller) {
          await new Promise((r) => setTimeout(r, 25)); // hold the slot open
          controller.enqueue(new TextEncoder().encode(page(String(input))));
          controller.close();
          perHost.set(host, perHost.get(host)! - 1);
          inFlightTotal--;
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } });
    });

    // 16 pages across 4 domains (zipf-lite) — enough to fill all 4 slots.
    const urls: string[] = [];
    for (let d = 0; d < 4; d++) {
      for (let p = 0; p < 4; p++) urls.push(`https://par-${d}.example.com/page-${p}`);
    }
    await engine.seed(urls, { followLinks: false });
    await engine.start();
    // Wait on pagesIndexed (the LAST stat a page updates) — crawledCount
    // flips a microtask earlier and would race stop().
    await waitFor(() => engine.getStats().pagesIndexed >= 16);
    expect(await storage.crawledCount()).toBeGreaterThanOrEqual(16);
    await engine.stop();

    for (const [host, max] of maxPerHost) {
      expect(max, `${host} exceeded 1 concurrent request`).toBeLessThanOrEqual(1);
    }
    expect(maxInFlightTotal).toBeGreaterThanOrEqual(2); // parallelism is real
    expect(engine.getStats().pagesIndexed).toBe(16);
  });

  it('invariant (ii): the robots.txt warm-up occupies the domain lane — the page waits ≥ minInterval after it', async () => {
    const MIN_INTERVAL = 150;
    const { engine, fetchMock } = makeHarness({
      respectRobots: true,
      parallelism: 2,
      minIntervalPerDomainMs: MIN_INTERVAL,
    });
    const requestLog: Array<{ url: string; at: number }> = [];
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      requestLog.push({ url, at: Date.now() });
      if (url.endsWith('/robots.txt')) return new Response('not found', { status: 404 });
      return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
    });

    await engine.seed(['https://robots-lane.example.com/a', 'https://robots-lane.example.com/b'], {
      followLinks: false,
    });
    await engine.start();
    await waitFor(() => requestLog.filter((r) => !r.url.endsWith('/robots.txt')).length >= 2);
    await engine.stop();

    const robots = requestLog.find((r) => r.url.endsWith('/robots.txt'));
    const pages = requestLog.filter((r) => !r.url.endsWith('/robots.txt'));
    expect(robots).toBeDefined();
    expect(requestLog[0]).toBe(robots); // robots BEFORE any page request
    // Page requests start ≥ minInterval after the robots request started.
    for (const page of pages) {
      expect(page.at - robots!.at).toBeGreaterThanOrEqual(MIN_INTERVAL - 10); // timer slack
    }
    if (pages.length === 2) {
      expect(Math.abs(pages[1]!.at - pages[0]!.at)).toBeGreaterThanOrEqual(MIN_INTERVAL - 10);
    }
  });

  it('invariant (iii) end-to-end: pages/hour is a hard ceiling with 4 slots', async () => {
    const { engine, storage, fetchMock } = makeHarness({
      respectRobots: false,
      parallelism: 4,
      minIntervalPerDomainMs: 0,
      maxPagesPerHour: 3,
    });
    fetchMock.mockImplementation(
      async (input: unknown) =>
        new Response(page(String(input)), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );

    const urls: string[] = [];
    for (let d = 0; d < 6; d++) urls.push(`https://budget-${d}.example.com/`);
    await engine.seed(urls, { followLinks: false });
    await engine.start();
    // Wait until the 3 budgeted pages have completed (slots would overshoot
    // to 4+ in-flight without reserve-on-dispatch).
    await waitFor(() => engine.getStats().pagesIndexed >= 3);
    await new Promise((r) => setTimeout(r, 100)); // no further dispatches
    await engine.stop();

    const pageRequests = fetchMock.mock.calls.length;
    expect(pageRequests).toBe(3); // hard ceiling — exactly the budget
    expect(engine.getStats().pagesIndexed).toBe(3);
    expect(await storage.queueSize()).toBeGreaterThan(0); // the rest wait
  });

  it('publish lane off the critical path: a NEVER-resolving relay does not block the crawl', async () => {
    const { engine, fetchMock } = makeHarness({
      respectRobots: false,
      parallelism: 2,
      minIntervalPerDomainMs: 0,
      publish: () => new Promise<void>(() => {}), // hangs forever
    });
    fetchMock.mockImplementation(
      async (input: unknown) =>
        new Response(page(String(input)), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );

    const urls = [0, 1, 2].map((i) => `https://hanging-${i}.example.com/`);
    await engine.seed(urls, { followLinks: false });
    await engine.start();
    // All 3 pages crawl to completion with the relay hanging — fan-out is
    // fire-and-track, not awaited by the pipeline.
    await waitFor(() => engine.getStats().pagesIndexed >= 3);
    expect(engine.getStats().published).toBe(0); // nothing acked (nothing resolved)
    // stop() drains the lane with a grace period — it must not hang.
    const stopStart = Date.now();
    await engine.stop();
    expect(Date.now() - stopStart).toBeLessThan(10_000);
  }, 15_000);

  it('publish lane: a throwing signer surfaces an error event without breaking the crawl', async () => {
    const { engine, fetchMock } = makeHarness({
      respectRobots: false,
      parallelism: 1,
      minIntervalPerDomainMs: 0,
      signer: async () => {
        throw new Error('no key');
      },
    });
    fetchMock.mockImplementation(
      async (input: unknown) =>
        new Response(page(String(input)), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const errors: unknown[] = [];
    engine.on((event) => {
      if (event.type === 'error') errors.push(event.error);
    });

    await engine.seed(['https://signfail.example.com/'], { followLinks: false });
    await engine.start();
    await waitFor(() => engine.getStats().pagesIndexed >= 1);
    await waitFor(() => errors.length >= 1);
    await engine.stop();

    expect(engine.getStats().pagesIndexed).toBe(1); // the page still indexed
    expect(engine.getStats().published).toBe(0);
    expect(String(errors[0])).toContain('no key');
  });

  it('a claimed job that crashes mid-crawl is re-enqueued with backoff, not dropped', async () => {
    const { engine, storage, fetchMock } = makeHarness({
      respectRobots: false,
      parallelism: 1,
      minIntervalPerDomainMs: 0,
    });
    fetchMock.mockResolvedValue(
      new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    // Corrupt the worker pool's parse to throw once.
    const pool = (engine as unknown as { pool: { processPage: (h: string, u: string) => Promise<never> } }).pool;
    pool.processPage = () => Promise.reject(new Error('boom'));

    await engine.seed(['https://crash.example.com/'], { followLinks: false });
    await engine.start();
    // Wait for the crash to happen (errors++ before the re-enqueue lands).
    await waitFor(() => engine.getStats().errors >= 1);
    // Backed-off: nextJob's ready-scan skips it until the backoff elapses.
    await waitFor(async () => (await storage.nextJob()) === null);
    await engine.stop();

    expect(engine.getStats().errors).toBeGreaterThanOrEqual(1);
    // The job survived: still queued (backed off), not failed after 1 crash.
    expect(await storage.isQueued('https://crash.example.com/')).toBe(true);
    expect(await storage.getCrawled('https://crash.example.com/')).toBeUndefined();
  });
});

describe('batched link admission (P3 — one IDB transaction per page)', () => {
  const now = 10_000_000_000;

  const pageWithLinks = (links: string[], marker: string) =>
    `<!doctype html><html><head><title>batch ${marker}</title></head><body>
      <p>${'word '.repeat(30)} ${marker}</p>
      ${links.map((l) => `<a href="${l}">l</a>`).join('')}
    </body></html>`;

  it('a page\'s whole link set lands in ONE putJobs transaction', async () => {
    const { engine, storage, fetchMock } = makeHarness({
      respectRobots: false,
      clock: () => now,
    });
    const putJobsSpy = vi.spyOn(storage, 'putJobs');
    const links = [
      'https://batch-a.example.com/1',
      'https://batch-b.example.com/2',
      'https://batch-c.example.com/3',
    ];
    fetchMock.mockResolvedValue(
      new Response(pageWithLinks(links, 'one'), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const job = { ...makeJob('https://batch.example.com/page'), followLinks: true };
    const post = await internals(engine).crawlUrl(job);
    // The link set is admitted in postCrawl (outside the slot hold) — drive
    // it the way the slot runner does.
    expect(post).not.toBeNull();
    await internals(engine).postCrawl(post!.job, post!.parsed);

    expect(putJobsSpy).toHaveBeenCalledTimes(1);
    expect(putJobsSpy.mock.calls[0]![0]).toHaveLength(3);
    for (const link of links) expect(await storage.isQueued(link)).toBe(true);
    expect(engine.getStats().discovered).toBe(3);
  });

  it('admitMany: dedup (fetched + fresh negative), TTL re-admission, cap headroom', async () => {
    const { engine, storage } = makeHarness({ clock: () => now, maxQueueSize: 4 });
    await storage.markCrawled('https://m.example.com/fetched', 'sha256:x', 't', {
      status: 'fetched',
      at: now,
      recrawlDue: now + 1_000_000,
    });
    await storage.markCrawled('https://m.example.com/fresh-fail', '', '', {
      status: 'failed',
      at: now,
    });
    await storage.markCrawled('https://m.example.com/expired-fail', '', '', {
      status: 'failed',
      at: now - NEGATIVE_CACHE_TTL_MS - 1,
    });

    const result = await engine.admitMany(
      [
        'https://m.example.com/fetched', // duplicate (recrawl not due)
        'https://m.example.com/fresh-fail', // duplicate (negative, fresh)
        'https://m.example.com/expired-fail', // TTL expired → re-admissible
        'https://m.example.com/new-1',
        'https://m.example.com/new-2',
        'https://m.example.com/new-3',
        'https://m.example.com/new-4', // exceeds cap headroom (5)
        'http://169.254.169.254/x', // SSRF → rejected
        'https://m.example.com/new-1', // in-batch duplicate
      ],
      { priority: 0.5, applyTraps: true },
    );

    expect(result.duplicates).toBe(2);
    expect(result.queued).toBe(4); // expired-fail + new-1..new-3 (cap headroom = 4)
    expect(result.rejected).toBe(3); // over-cap + SSRF + in-batch dup
    expect(await storage.queueSize()).toBe(4); // cap respected
    expect(await storage.isQueued('https://m.example.com/expired-fail')).toBe(true);
    expect(await storage.isQueued('https://m.example.com/new-4')).toBe(false);
  });

  it('admitMany on an empty/all-filtered batch performs NO writes', async () => {
    const { engine, storage } = makeHarness({ clock: () => now });
    const putJobsSpy = vi.spyOn(storage, 'putJobs');
    const result = await engine.admitMany(['http://10.0.0.1/internal'], { priority: 1 });
    expect(result).toEqual({ queued: 0, duplicates: 0, rejected: 1 });
    expect(putJobsSpy).not.toHaveBeenCalled();
    expect(await storage.queueSize()).toBe(0);
  });
});

describe('network intake budget charging (F6 — dedup BEFORE budget)', () => {
  const victim = 'cc'.repeat(32);

  it('replayed duplicate observations do NOT burn the indexer budget', async () => {
    const { engine, storage, intakeEvents } = makeHarness({ intake: true });
    // 150 replays of the same already-queued URL from one indexer. The
    // per-indexer session cap is 100 — pre-fix, this exhausted the victim's
    // budget; now duplicates are filtered before any budget is charged.
    const url = 'https://example.com/already-queued';
    await storage.putJob({ url, priority: 0.5, depth: 0, attempts: 0 });
    for (let i = 0; i < 150; i++) {
      intakeEvents.push(makeEvent(victim, url, String(i).padStart(4, '0').repeat(16)));
    }

    internals(engine).running = true;
    await engine.networkIntake();

    expect(await storage.queueSize()).toBe(1); // only the pre-queued job
    const guard = internals(engine).intake!.sybilGuard;
    for (let i = 0; i < 100; i++) expect(guard.allow(victim)).toBe(true);
    expect(guard.allow(victim)).toBe(false); // cap semantics unchanged
  });

  it('already-crawled duplicates do not burn budget either', async () => {
    const { engine, storage, intakeEvents } = makeHarness({ intake: true });
    const url = 'https://example.com/already-crawled';
    await storage.markCrawled(url, 'sha256:x', 't', { status: 'fetched' });
    for (let i = 0; i < 120; i++) {
      intakeEvents.push(makeEvent(victim, url, String(i + 200).padStart(4, '0').repeat(16)));
    }

    internals(engine).running = true;
    await engine.networkIntake();

    expect(await storage.queueSize()).toBe(0);
    expect(internals(engine).intake!.sybilGuard.allow(victim)).toBe(true);
  });

  it('fresh URLs still charge the budget exactly once', async () => {
    const { engine, storage, intakeEvents } = makeHarness({ intake: true });
    for (let i = 0; i < 3; i++) {
      intakeEvents.push(
        makeEvent(victim, `https://example.com/fresh-${i}`, String(i + 400).padStart(4, '0').repeat(16)),
      );
    }

    internals(engine).running = true;
    await engine.networkIntake();

    expect(await storage.queueSize()).toBe(3);
    const guard = internals(engine).intake!.sybilGuard;
    for (let i = 0; i < 97; i++) expect(guard.allow(victim)).toBe(true);
    expect(guard.allow(victim)).toBe(false); // 3 + 97 = 100 cap reached
  });
});
