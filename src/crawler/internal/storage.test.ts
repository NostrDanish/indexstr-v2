/**
 * storage.test.ts — outbox tests ported from crawlstr queue.test.ts (now
 * against REAL IndexedDB via fake-indexeddb, not an in-memory model) plus
 * real nextJob scheduling tests (audit finding #3: the ready-job cursor
 * walk) and the status-field semantics (observed ≠ fetched; failed =
 * negative cache).
 */
import 'fake-indexeddb/auto';

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { openDB } from 'idb';

import {
  createIdbStorage,
  CRAWLED_EVICT_BATCH,
  NEGATIVE_CACHE_TTL_MS,
  OUTBOX_MAX,
  type CrawlerStorage,
} from './storage';
import type { CrawlJob } from './types';

let dbCounter = 0;
const fresh = (): CrawlerStorage => createIdbStorage(`crawler-core-storage-test-${++dbCounter}`);

function fakeEvent(id: string): NostrEvent {
  return {
    id,
    kind: 39697,
    pubkey: 'a'.repeat(64),
    sig: 'b'.repeat(128),
    created_at: Math.floor(Date.now() / 1000),
    content: '{"title":"t"}',
    tags: [['d', `widx:${id}`]],
  };
}

function job(url: string, priority: number, nextAttempt?: number): CrawlJob {
  return { url, priority, depth: 0, attempts: 0, nextAttempt };
}

describe('observation outbox (audit finding #3 / contract C-2)', () => {
  it('persists events and reports its size', async () => {
    const s = fresh();
    expect(await s.outboxSize()).toBe(0);
    await s.enqueueOutbox(fakeEvent('e1'), Date.now());
    await s.enqueueOutbox(fakeEvent('e2'), Date.now());
    expect(await s.outboxSize()).toBe(2);
  });

  it('flush stops at the first failure — nothing is lost on a dead network', async () => {
    const s = fresh();
    await s.enqueueOutbox(fakeEvent('e1'), Date.now());
    await s.enqueueOutbox(fakeEvent('e2'), Date.now());

    const delivered = await s.flushOutbox(async () => false);
    expect(delivered).toBe(0);
    expect(await s.outboxSize()).toBe(2); // still held for next time
  });

  it('flush drains in FIFO order and removes only delivered entries', async () => {
    const s = fresh();
    await s.enqueueOutbox(fakeEvent('e1'), Date.now());
    await s.enqueueOutbox(fakeEvent('e2'), Date.now());
    await s.enqueueOutbox(fakeEvent('e3'), Date.now());

    const order: string[] = [];
    const delivered = await s.flushOutbox(async (event) => {
      order.push(event.id);
      return order.length < 2; // deliver e1, then fail on e2
    });

    expect(delivered).toBe(1);
    expect(order).toEqual(['e1', 'e2']); // e2 attempted, failed, retained
    expect(await s.outboxSize()).toBe(2);

    const rest: string[] = [];
    await s.flushOutbox(async (event) => {
      rest.push(event.id);
      return true;
    });
    expect(rest).toEqual(['e2', 'e3']);
    expect(await s.outboxSize()).toBe(0);
  });

  it('caps at OUTBOX_MAX with newest-wins eviction', { timeout: 60_000 }, async () => {
    const s = fresh();
    for (let i = 0; i < OUTBOX_MAX + 10; i++) {
      await s.enqueueOutbox(fakeEvent(`ev-${i}`), Date.now());
    }
    expect(await s.outboxSize()).toBe(OUTBOX_MAX);

    // The OLDEST entries were dropped; the newest survive.
    const drained: string[] = [];
    await s.flushOutbox(async (event) => {
      drained.push(event.id);
      return true;
    });
    expect(drained).not.toContain('ev-0');
    expect(drained).toContain(`ev-${OUTBOX_MAX + 9}`);
  });
});

describe('ready-job scheduling (audit finding #3, against real IDB)', () => {
  it('returns the highest-priority READY job, not just the highest-priority job', async () => {
    const s = fresh();
    const now = Date.now();
    await s.putJob(job('https://delayed.example/', 1.0, now + 120_000));
    await s.putJob(job('https://ready-a.example/', 0.8));
    await s.putJob(job('https://ready-b.example/', 0.6));
    expect((await s.nextJob())?.url).toBe('https://ready-a.example/');
  });

  it('returns null only when EVERYTHING is delayed', async () => {
    const s = fresh();
    const now = Date.now();
    await s.putJob(job('https://a.example/', 1.0, now + 60_000));
    await s.putJob(job('https://b.example/', 0.5, now + 30_000));
    expect(await s.nextJob()).toBeNull();
  });

  it('a due retry beats a fresh lower-priority job', async () => {
    const s = fresh();
    const now = Date.now();
    await s.putJob(job('https://retry.example/', 0.9, now - 1000));
    await s.putJob(job('https://fresh.example/', 0.5));
    expect((await s.nextJob())?.url).toBe('https://retry.example/');
  });

  it('shard-preferential pick: home shard wins when work exists there', async () => {
    const s = fresh();
    await s.putJob({ ...job('https://elsewhere.example/', 0.9), shard: 42 });
    await s.putJob({ ...job('https://home.example/', 0.1), shard: 7 });
    const picked = await s.nextJob(7, 0); // crossSample 0 = always home
    expect(picked?.url).toBe('https://home.example/');
  });

  it('falls back to the whole queue when the home shard is empty', async () => {
    const s = fresh();
    await s.putJob({ ...job('https://elsewhere.example/', 0.9), shard: 42 });
    const picked = await s.nextJob(7, 0);
    expect(picked?.url).toBe('https://elsewhere.example/');
  });
});

describe('crawled status semantics', () => {
  it('observed ≠ fetched: observed entries never block a real fetch', async () => {
    const s = fresh();
    await s.markCrawled('https://example.com/a', 'sha256:x', 't', { status: 'observed' });
    expect(await s.isFetched('https://example.com/a')).toBe(false);
    expect((await s.getCrawled('https://example.com/a'))?.status).toBe('observed');
  });

  it('failed is a negative-cache entry (not fetched)', async () => {
    const s = fresh();
    await s.markCrawled('https://example.com/404', '', '', { status: 'failed' });
    expect(await s.isFetched('https://example.com/404')).toBe(false);
    expect(await s.getCrawled('https://example.com/404')).toBeDefined();
  });

  it('records written before the status field existed read back as fetched', async () => {
    const s = fresh();
    await s.markCrawled('https://example.com/old', 'sha256:y', 't', { status: 'fetched' });
    expect(await s.isFetched('https://example.com/old')).toBe(true);
  });

  it('findByHash drives duplicate detection', async () => {
    const s = fresh();
    await s.markCrawled('https://example.com/a', 'sha256:same', 't');
    expect(await s.findByHash('sha256:same')).toBe('https://example.com/a');
    expect(await s.findByHash('sha256:other')).toBeNull();
  });
});

describe('recentCrawled / clearQueue / clearAll (dashboard surface)', () => {
  it('recentCrawled is fetched-only by default, newest first', async () => {
    const s = fresh();
    await s.markCrawled('https://example.com/old', 'sha256:1', 'old', {
      status: 'fetched',
      at: 1000,
    });
    await s.markCrawled('https://example.com/new', 'sha256:2', 'new', {
      status: 'fetched',
      at: 3000,
    });
    await s.markCrawled('https://example.com/feed', 'sha256:3', 'feed', {
      status: 'observed',
      at: 2000,
    });
    await s.markCrawled('https://example.com/404', '', '', { status: 'failed', at: 4000 });

    const fetched = await s.recentCrawled(20);
    expect(fetched.map((r) => r.url)).toEqual([
      'https://example.com/new',
      'https://example.com/old',
    ]);

    const withObserved = await s.recentCrawled(20, ['fetched', 'observed']);
    expect(withObserved.map((r) => r.url)).toEqual([
      'https://example.com/new',
      'https://example.com/feed',
      'https://example.com/old',
    ]);

    const everything = await s.recentCrawled(20, ['fetched', 'observed', 'failed']);
    expect(everything).toHaveLength(4);
    expect(everything[0].url).toBe('https://example.com/404');

    // Filtering happens BEFORE the limit: a failed row newer than the
    // fetched rows must not eat a history slot.
    const one = await s.recentCrawled(1);
    expect(one.map((r) => r.url)).toEqual(['https://example.com/new']);
  });

  it('clearQueue empties the queue but keeps crawled history and outbox', async () => {
    const s = fresh();
    await s.putJob(job('https://example.com/a', 1));
    await s.markCrawled('https://example.com/b', 'sha256:b', 't');
    await s.enqueueOutbox(fakeEvent('e1'), Date.now());

    await s.clearQueue();
    expect(await s.queueSize()).toBe(0);
    expect(await s.crawledCount()).toBe(1);
    expect(await s.outboxSize()).toBe(1);
  });

  it('clearAll wipes queue + crawled + outbox atomically', async () => {
    const s = fresh();
    await s.putJob(job('https://example.com/a', 1));
    await s.markCrawled('https://example.com/b', 'sha256:b', 't');
    await s.enqueueOutbox(fakeEvent('e1'), Date.now());

    await s.clearAll();
    expect(await s.queueSize()).toBe(0);
    expect(await s.crawledCount()).toBe(0);
    expect(await s.outboxSize()).toBe(0);
  });

  it('recentCrawled walks the by-crawledAt index — correct over thousands of rows', async () => {
    const s = fresh();
    // 3,000 fetched rows + 3,000 failed rows interleaved in time; the
    // history window must still return exactly the newest 20 FETCHED rows.
    for (let i = 0; i < 3000; i++) {
      await s.markCrawled(`https://bulk.example/f${i}`, `sha256:f${i}`, 't', {
        status: 'fetched',
        at: 10_000 + i * 2,
      });
      await s.markCrawled(`https://bulk.example/x${i}`, '', '', {
        status: 'failed',
        at: 10_000 + i * 2 + 1,
      });
    }
    const recent = await s.recentCrawled(20);
    expect(recent).toHaveLength(20);
    expect(recent[0]!.url).toBe('https://bulk.example/f2999');
    expect(recent[19]!.url).toBe('https://bulk.example/f2980');
    // Strictly newest-first.
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i]!.crawledAt).toBeLessThan(recent[i - 1]!.crawledAt);
    }
  });
});

describe('crawled-store eviction (blueprint §4.3 — 250k soft cap)', () => {
  it('evicts the oldest records first when over the cap', async () => {
    const now = Date.now();
    const s = createIdbStorage(`crawler-core-evict-test-${++dbCounter}`, { crawledMax: 10 });
    for (let i = 0; i < 15; i++) {
      await s.markCrawled(`https://evict.example/${i}`, `sha256:${i}`, 't', {
        status: 'fetched',
        at: now - (15 - i) * 60_000, // oldest first: /0 is oldest
      });
    }
    expect(await s.crawledCount()).toBe(15);

    const evicted = await s.evictCrawled(now);
    expect(evicted).toBe(5);
    expect(await s.crawledCount()).toBe(10);
    expect(await s.getCrawled('https://evict.example/0')).toBeUndefined(); // oldest gone
    expect(await s.getCrawled('https://evict.example/4')).toBeUndefined();
    expect(await s.getCrawled('https://evict.example/5')).toBeDefined(); // newest kept
    expect(await s.getCrawled('https://evict.example/14')).toBeDefined();
  });

  it('is a no-op at or below the cap', async () => {
    const s = createIdbStorage(`crawler-core-evict-test-${++dbCounter}`, { crawledMax: 10 });
    for (let i = 0; i < 10; i++) {
      await s.markCrawled(`https://evict.example/${i}`, `sha256:${i}`, 't');
    }
    expect(await s.evictCrawled(Date.now())).toBe(0);
    expect(await s.crawledCount()).toBe(10);
  });

  it('NEVER evicts records inside their freshness interval (live recrawl state)', async () => {
    const now = Date.now();
    const s = createIdbStorage(`crawler-core-evict-test-${++dbCounter}`, { crawledMax: 3 });
    // 4 old records, but the two oldest are still within their freshness
    // interval — eviction must skip them and take the next-oldest instead.
    await s.markCrawled('https://evict.example/protected-1', 'sha256:a', 't', {
      status: 'fetched',
      at: now - 100 * 60_000,
      recrawlDue: now + 60_000,
    });
    await s.markCrawled('https://evict.example/protected-2', 'sha256:b', 't', {
      status: 'fetched',
      at: now - 99 * 60_000,
      recrawlDue: now + 60_000,
    });
    await s.markCrawled('https://evict.example/plain-1', 'sha256:c', 't', {
      status: 'fetched',
      at: now - 98 * 60_000,
    });
    await s.markCrawled('https://evict.example/plain-2', 'sha256:d', 't', {
      status: 'fetched',
      at: now - 97 * 60_000,
    });

    const evicted = await s.evictCrawled(now);
    expect(evicted).toBe(1); // cap 3, 4 records → 1 eviction
    expect(await s.getCrawled('https://evict.example/protected-1')).toBeDefined();
    expect(await s.getCrawled('https://evict.example/protected-2')).toBeDefined();
    expect(await s.getCrawled('https://evict.example/plain-1')).toBeUndefined();
    expect(await s.getCrawled('https://evict.example/plain-2')).toBeDefined();
  });

  it('stops when only protected records remain (may stay over cap)', async () => {
    const now = Date.now();
    const s = createIdbStorage(`crawler-core-evict-test-${++dbCounter}`, { crawledMax: 1 });
    for (let i = 0; i < 4; i++) {
      await s.markCrawled(`https://evict.example/p${i}`, `sha256:${i}`, 't', {
        status: 'fetched',
        at: now - (10 - i) * 60_000,
        recrawlDue: now + 60_000, // ALL protected
      });
    }
    expect(await s.evictCrawled(now)).toBe(0);
    expect(await s.crawledCount()).toBe(4); // recrawl state wins over the cap
  });

  it('evicts in batches bounded by CRAWLED_EVICT_BATCH', async () => {
    expect(CRAWLED_EVICT_BATCH).toBe(5000); // pinned batch size (blueprint §4.3)
    const now = Date.now();
    const s = createIdbStorage(`crawler-core-evict-test-${++dbCounter}`, { crawledMax: 0 });
    for (let i = 0; i < 12; i++) {
      await s.markCrawled(`https://evict.example/b${i}`, `sha256:${i}`, 't', {
        status: 'failed',
        at: now - (12 - i) * 1000,
      });
    }
    expect(await s.evictCrawled(now)).toBe(12); // small store: one batch drains it
    expect(await s.crawledCount()).toBe(0);
  });
});

describe('negative-cache TTL sweep (7d — permanent failures are retried eventually)', () => {
  it('pins the TTL at 7 days', () => {
    expect(NEGATIVE_CACHE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('evicts expired failed entries, keeps fresh ones and non-failed rows', async () => {
    const now = 10_000_000_000; // fixed fake "now"
    const s = createIdbStorage(`crawler-core-ttl-test-${++dbCounter}`);
    await s.markCrawled('https://neg.example/old-404', '', '', {
      status: 'failed',
      at: now - NEGATIVE_CACHE_TTL_MS - 1000, // expired
    });
    await s.markCrawled('https://neg.example/fresh-404', '', '', {
      status: 'failed',
      at: now - 60_000, // within TTL
    });
    await s.markCrawled('https://neg.example/old-fetched', 'sha256:x', 't', {
      status: 'fetched',
      at: now - NEGATIVE_CACHE_TTL_MS - 1000, // old but NOT a negative
    });
    await s.markCrawled('https://neg.example/old-observed', 'sha256:y', 't', {
      status: 'observed',
      at: now - NEGATIVE_CACHE_TTL_MS - 1000,
    });

    const swept = await s.sweepExpiredFailures(now);
    expect(swept).toBe(1);
    expect(await s.getCrawled('https://neg.example/old-404')).toBeUndefined();
    expect(await s.getCrawled('https://neg.example/fresh-404')).toBeDefined();
    expect(await s.getCrawled('https://neg.example/old-fetched')).toBeDefined();
    expect(await s.getCrawled('https://neg.example/old-observed')).toBeDefined();
  });

  it('boundary: exactly at the TTL is expired; one ms inside is not', async () => {
    const now = 10_000_000_000;
    const s = createIdbStorage(`crawler-core-ttl-test-${++dbCounter}`);
    await s.markCrawled('https://neg.example/edge', '', '', {
      status: 'failed',
      at: now - NEGATIVE_CACHE_TTL_MS,
    });
    await s.markCrawled('https://neg.example/inside', '', '', {
      status: 'failed',
      at: now - NEGATIVE_CACHE_TTL_MS + 1,
    });
    expect(await s.sweepExpiredFailures(now)).toBe(1);
    expect(await s.getCrawled('https://neg.example/edge')).toBeUndefined();
    expect(await s.getCrawled('https://neg.example/inside')).toBeDefined();
  });

  it('honors a host-configured TTL override', async () => {
    const now = 10_000_000_000;
    const s = createIdbStorage(`crawler-core-ttl-test-${++dbCounter}`, {
      negativeTtlMs: 60_000,
    });
    await s.markCrawled('https://neg.example/x', '', '', {
      status: 'failed',
      at: now - 61_000,
    });
    expect(await s.sweepExpiredFailures(now)).toBe(1);
    expect(await s.crawledCount()).toBe(0);
  });
});

describe('DB v3 → v4 migration (by-crawledAt index)', () => {
  it('a v3 database upgrades in place and serves index-backed queries', async () => {
    const name = `crawler-core-migration-test-${++dbCounter}`;

    // Build a v3 database with the pre-P2 schema (no by-crawledAt index).
    const v3 = await openDB(name, 3, {
      upgrade(database, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          const queueStore = database.createObjectStore('queue', { keyPath: 'url' });
          queueStore.createIndex('by-priority', 'priority');
          const crawledStore = database.createObjectStore('crawled', { keyPath: 'url' });
          crawledStore.createIndex('by-hash', 'contentHash');
        }
        if (oldVersion < 2) {
          const queueStore = tx.objectStore('queue');
          if (!queueStore.indexNames.contains('by-shard')) {
            queueStore.createIndex('by-shard', 'shard');
          }
          if (!database.objectStoreNames.contains('outbox')) {
            database.createObjectStore('outbox', { autoIncrement: true });
          }
        }
        if (oldVersion < 3) {
          const queueStore = tx.objectStore('queue');
          if (!queueStore.indexNames.contains('by-shard-priority')) {
            queueStore.createIndex('by-shard-priority', ['shard', 'priority']);
          }
        }
      },
    });
    // A v1-style record: no status field at all.
    await v3.put('crawled', {
      url: 'https://legacy.example/a',
      contentHash: 'sha256:legacy',
      title: 'legacy',
      crawledAt: 123_000,
    });
    await v3.put('crawled', {
      url: 'https://legacy.example/b',
      contentHash: 'sha256:legacy2',
      title: 'legacy2',
      crawledAt: 456_000,
      status: 'failed',
    });
    v3.close();

    // Reopen through the adapter — v4 upgrade adds by-crawledAt.
    const s = createIdbStorage(name);
    const recent = await s.recentCrawled(10, ['fetched', 'failed']);
    expect(recent.map((r) => r.url)).toEqual([
      'https://legacy.example/b',
      'https://legacy.example/a',
    ]);
    // Pre-status rows still read back as fetched.
    expect((await s.getCrawled('https://legacy.example/a'))?.status).toBe('fetched');
    // Eviction works on migrated data too.
    expect(await s.evictCrawled(1_000_000)).toBe(0); // under the default cap
    s.close();
  });
});
