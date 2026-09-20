/**
 * storage.ts — IndexedDB storage adapter: crawl queue, crawled records
 * (with freshness bookkeeping + negative-cache entries), and the
 * observation outbox.
 *
 * Schema (v4; per-app `dbName` keeps databases separate — no cross-app
 * migration; v1/v3 databases migrate forward through the upgrade chain):
 *   queue:   keyPath url; indexes by-priority, by-shard,
 *            by-shard-priority (compound — priority cursor WITHIN a shard)
 *   crawled: keyPath url; indexes by-hash, by-crawledAt (v4 — reverse-cursor
 *            "recent crawls" + oldest-first eviction; the v1 getAll()+sort
 *            stats poll is deleted);
 *            status: fetched|observed|failed; bounded at CRAWLED_MAX soft cap
 *   outbox:  autoIncrement; signed events awaiting relay connectivity,
 *            OUTBOX_MAX=5000 newest-wins
 *
 * The storage adapter is a host-injectable seam (CrawlerConfig.storage);
 * this IndexedDB implementation is the default. Single-writer discipline:
 * per crawled page the engine uses ONE readwrite transaction via
 * `completeJob()` instead of v1's 7–12 separate transactions.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { NostrEvent } from '@nostrify/nostrify';
import type { CrawlJob, CrawledRecord } from './types';

/** Upper bound for held observations. On overflow the OLDEST entry is
 *  dropped (newest wins): fresh observations are more valuable to the
 *  index than stale ones, and a re-crawl can always reproduce the old. */
export const OUTBOX_MAX = 5000;

/** Soft cap on the crawled store (blueprint §4.3). On overflow, eviction
 *  removes the OLDEST records first — except records still inside their
 *  freshness interval (recrawlDue in the future): those are live recrawl
 *  state, not history. */
export const CRAWLED_MAX = 250_000;

/** Eviction batch size (records per transaction). */
export const CRAWLED_EVICT_BATCH = 5000;

/** Negative-cache TTL: a 'failed' record blocks re-admission for 7 days,
 *  then becomes eligible again (sweep evicts it; admit() also treats an
 *  expired entry as re-admissible between sweeps). */
export const NEGATIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CrawlerDB extends DBSchema {
  queue: {
    key: string;
    value: CrawlJob;
    indexes: {
      'by-priority': number;
      'by-shard': number;
      /** Compound: priority-ordered cursor WITHIN one shard. */
      'by-shard-priority': [number, number];
    };
  };
  crawled: {
    key: string;
    value: CrawledRecord;
    indexes: { 'by-hash': string; 'by-crawledAt': number };
  };
  outbox: {
    key: number;
    value: { event: NostrEvent; queuedAt: number };
  };
}

/** The host-injectable storage seam. */
export interface CrawlerStorage {
  putJob(job: CrawlJob): Promise<void>;
  putJobs(jobs: CrawlJob[]): Promise<void>;
  nextJob(
    homeShard?: number,
    crossSample?: number,
    avoidDomain?: string,
  ): Promise<CrawlJob | null>;
  removeJob(url: string): Promise<void>;
  queueSize(): Promise<number>;
  queueShardCount(shard: number): Promise<number>;
  isQueued(url: string): Promise<boolean>;
  clearQueue(): Promise<void>;
  /** Wipe ALL local state: queue + crawled history (incl. the negative
   *  cache) + outbox. The explicit user "reset everything" action. */
  clearAll(): Promise<void>;

  getCrawled(url: string): Promise<CrawledRecord | undefined>;
  markCrawled(
    url: string,
    contentHash: string,
    title: string,
    opts?: MarkCrawledOptions,
  ): Promise<void>;
  isFetched(url: string): Promise<boolean>;
  findByHash(hash: string): Promise<string | null>;
  crawledCount(): Promise<number>;
  /**
   * Recently crawled records, newest first, served from the `by-crawledAt`
   * index (reverse cursor — O(limit), not the v1 getAll()+sort of the whole
   * store). `include` selects which statuses count (default: real fetches
   * only — negative-cache and feed-observation rows are not history
   * material). Rows written before the status field existed (v1 schema)
   * read as 'fetched'.
   */
  recentCrawled(
    limit?: number,
    include?: Array<CrawledRecord['status']>,
  ): Promise<CrawledRecord[]>;
  /**
   * Bounded-growth eviction (blueprint §4.3): when the crawled store exceeds
   * CRAWLED_MAX, delete the oldest records (by-crawledAt cursor) in
   * CRAWLED_EVICT_BATCH-sized transactions — but NEVER a record whose
   * recrawlDue is still in the future (that's live recrawl state, not
   * history). Returns how many records were evicted.
   */
  evictCrawled(now: number): Promise<number>;
  /**
   * Negative-cache TTL sweep (blueprint §4.3): 'failed' records older than
   * NEGATIVE_CACHE_TTL_MS (7 days) are evicted so the URL can be retried
   * eventually — permanent failures are cached, not eternal. Returns how
   * many entries expired.
   */
  sweepExpiredFailures(now: number): Promise<number>;

  enqueueOutbox(event: NostrEvent, queuedAt: number): Promise<void>;
  outboxSize(): Promise<number>;
  flushOutbox(publish: (event: NostrEvent) => Promise<boolean>): Promise<number>;

  close(): void;
}

export interface MarkCrawledOptions {
  status?: 'fetched' | 'observed' | 'failed';
  at?: number;
  topics?: string[];
  /** When this URL becomes eligible for recrawl (freshness scheduling). */
  recrawlDue?: number;
  changeCount?: number;
  unchangedStreak?: number;
  lastChangedAt?: number;
}

export interface IdbStorageOptions {
  /** Soft cap on the crawled store (default CRAWLED_MAX = 250k). */
  crawledMax?: number;
  /** Negative-cache TTL in ms (default NEGATIVE_CACHE_TTL_MS = 7 days). */
  negativeTtlMs?: number;
}

export function createIdbStorage(dbName: string, options: IdbStorageOptions = {}): CrawlerStorage {
  const crawledMax = options.crawledMax ?? CRAWLED_MAX;
  const negativeTtlMs = options.negativeTtlMs ?? NEGATIVE_CACHE_TTL_MS;
  let dbPromise: Promise<IDBPDatabase<CrawlerDB>> | null = null;

  const db = (): Promise<IDBPDatabase<CrawlerDB>> => {
    dbPromise ??= openDB<CrawlerDB>(dbName, 4, {
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
        if (oldVersion < 4) {
          // P2: crawledAt index — reverse-cursor recent queries + eviction.
          const crawledStore = tx.objectStore('crawled');
          if (!crawledStore.indexNames.contains('by-crawledAt')) {
            crawledStore.createIndex('by-crawledAt', 'crawledAt');
          }
        }
      },
    });
    return dbPromise;
  };

  return {
    async putJob(job) {
      await (await db()).put('queue', job);
    },

    /** Bulk-insert jobs in chunked (2k) transactions — seeding a curated
     *  collection can mean tens of thousands of URLs at once. */
    async putJobs(jobs) {
      const database = await db();
      const CHUNK = 2000;
      for (let i = 0; i < jobs.length; i += CHUNK) {
        const tx = database.transaction('queue', 'readwrite');
        for (const job of jobs.slice(i, i + CHUNK)) void tx.store.put(job);
        await tx.done;
      }
    },

    /**
     * Pick the next job.
     *
     * Shard-preferential scheduling: with probability (1 - crossSample) the
     * job comes from the node's home shard; otherwise from the whole queue.
     * Either way the highest-priority READY job wins — jobs whose
     * `nextAttempt` is in the future are skipped (bounded 500-entry scan).
     *
     * Domain fairness: `avoidDomain` (the previously served domain) is
     * skipped when other work exists, so one domain with 10k queued URLs
     * can't monopolize the crawler.
     */
    async nextJob(homeShard, crossSample = 0.25, avoidDomain) {
      const database = await db();

      const jobDomain = (job: CrawlJob): string => {
        try {
          return new URL(job.url).hostname;
        } catch {
          return '';
        }
      };

      const tryIndex = async (useHome: boolean): Promise<CrawlJob | null> => {
        const tx = database.transaction('queue', 'readonly');
        if (useHome && homeShard === undefined) return null;

        const index = tx.store.index(useHome ? 'by-shard-priority' : 'by-priority');
        let cursor = await index.openCursor(
          useHome && homeShard !== undefined
            ? IDBKeyRange.bound([homeShard, -Infinity], [homeShard, Infinity])
            : null,
          'prev',
        );

        let deferred: CrawlJob | null = null; // ready but same-domain — fallback
        let scanned = 0;
        while (cursor && scanned < 500) {
          scanned++;
          const job = cursor.value;
          const ready = !job.nextAttempt || Date.now() >= job.nextAttempt;
          if (ready) {
            const sameDomain = avoidDomain !== undefined && jobDomain(job) === avoidDomain;
            if (!sameDomain) return job;
            deferred ??= job;
          }
          cursor = await cursor.continue();
        }
        return deferred;
      };

      const wantHome = homeShard !== undefined && Math.random() >= crossSample;
      if (wantHome) {
        const home = await tryIndex(true);
        if (home) return home;
      }
      return tryIndex(false);
    },

    async removeJob(url) {
      await (await db()).delete('queue', url);
    },

    async queueSize() {
      return (await db()).count('queue');
    },

    async queueShardCount(shard) {
      const database = await db();
      const tx = database.transaction('queue', 'readonly');
      return tx.store.index('by-shard').count(IDBKeyRange.only(shard));
    },

    async isQueued(url) {
      return (await (await db()).getKey('queue', url)) !== undefined;
    },

    async clearQueue() {
      await (await db()).clear('queue');
    },

    async clearAll() {
      const database = await db();
      const tx = database.transaction(['queue', 'crawled', 'outbox'], 'readwrite');
      await Promise.all([
        tx.objectStore('queue').clear(),
        tx.objectStore('crawled').clear(),
        tx.objectStore('outbox').clear(),
        tx.done,
      ]);
    },

    async getCrawled(url) {
      const record = await (await db()).get('crawled', url);
      // Backfill: records written before the status field existed were,
      // by definition, fetched.
      if (record && !record.status) return { ...record, status: 'fetched' };
      return record;
    },

    async markCrawled(url, contentHash, title, opts = {}) {
      await (await db()).put('crawled', {
        url,
        contentHash,
        title,
        crawledAt: opts.at ?? Date.now(),
        status: opts.status ?? 'fetched',
        ...(opts.topics?.length ? { topics: opts.topics } : {}),
        ...(opts.recrawlDue !== undefined ? { recrawlDue: opts.recrawlDue } : {}),
        ...(opts.changeCount !== undefined ? { changeCount: opts.changeCount } : {}),
        ...(opts.unchangedStreak !== undefined ? { unchangedStreak: opts.unchangedStreak } : {}),
        ...(opts.lastChangedAt !== undefined ? { lastChangedAt: opts.lastChangedAt } : {}),
      });
    },

    /** True only when we ACTUALLY fetched and parsed the page. 'observed'
     *  (feed/sitemap-derived) and 'failed' entries don't count. */
    async isFetched(url) {
      const record = await this.getCrawled(url);
      return record?.status === 'fetched';
    },

    async findByHash(hash) {
      const database = await db();
      const tx = database.transaction('crawled', 'readonly');
      const result = await tx.store.index('by-hash').get(hash);
      return result?.url ?? null;
    },

    async crawledCount() {
      return (await db()).count('crawled');
    },

    /**
     * Recent-crawl history from the `by-crawledAt` index (reverse cursor,
     * newest first). Status filtering happens DURING the walk, before the
     * limit applies (a newer failed/observed row must not eat a history
     * slot). The walk is bounded (SCAN_CAP) so a store flooded with
     * excluded statuses can't turn this back into an O(store) poll.
     */
    async recentCrawled(limit = 20, include: Array<CrawledRecord['status']> = ['fetched']) {
      const database = await db();
      const tx = database.transaction('crawled', 'readonly');
      let cursor = await tx.store.index('by-crawledAt').openCursor(null, 'prev');
      const out: CrawledRecord[] = [];
      const SCAN_CAP = Math.max(2000, limit * 100);
      let scanned = 0;
      while (cursor && out.length < limit && scanned < SCAN_CAP) {
        scanned++;
        const record = cursor.value;
        // Rows written by v1 (pre-status schema) have no status = fetched.
        if (include.includes(record.status ?? 'fetched')) out.push(record);
        cursor = await cursor.continue();
      }
      return out;
    },

    /**
     * Oldest-first eviction via the by-crawledAt cursor, in batched
     * transactions. Records inside their freshness interval (recrawlDue in
     * the future) are recrawl state and are skipped — eviction may
     * under-deliver when everything old is protected; that's correct.
     */
    async evictCrawled(now) {
      const database = await db();
      let excess = (await database.count('crawled')) - crawledMax;
      if (excess <= 0) return 0;

      let evicted = 0;
      while (excess > 0) {
        const tx = database.transaction('crawled', 'readwrite');
        let cursor = await tx.store.index('by-crawledAt').openCursor();
        let batch = 0;
        while (cursor && batch < CRAWLED_EVICT_BATCH && batch < excess) {
          const record = cursor.value;
          const isLiveRecrawlState =
            record.recrawlDue !== undefined && record.recrawlDue > now;
          if (!isLiveRecrawlState) {
            void cursor.delete();
            batch++;
          }
          cursor = await cursor.continue();
        }
        await tx.done;
        evicted += batch;
        excess -= batch;
        if (batch === 0) break; // everything left is protected recrawl state
      }
      return evicted;
    },

    /**
     * Expire negative-cache entries past their TTL. The by-crawledAt cursor
     * only walks rows older than the cutoff, so this is O(expired), never
     * O(store). 'fetched'/'observed' rows are untouched.
     */
    async sweepExpiredFailures(now) {
      const database = await db();
      const cutoff = now - negativeTtlMs;
      const tx = database.transaction('crawled', 'readwrite');
      let cursor = await tx.store
        .index('by-crawledAt')
        .openCursor(IDBKeyRange.upperBound(cutoff));
      let swept = 0;
      while (cursor) {
        if ((cursor.value.status ?? 'fetched') === 'failed') {
          void cursor.delete();
          swept++;
        }
        cursor = await cursor.continue();
      }
      await tx.done;
      return swept;
    },

    async enqueueOutbox(event, queuedAt) {
      const database = await db();
      const count = await database.count('outbox');
      if (count >= OUTBOX_MAX) {
        // Newest-wins: drop the oldest held observation (auto-increment
        // keys mean the first cursor entry is the oldest).
        const tx = database.transaction('outbox', 'readwrite');
        const oldest = await tx.store.openCursor();
        if (oldest) await oldest.delete();
        await tx.done;
      }
      await database.add('outbox', { event, queuedAt });
    },

    async outboxSize() {
      return (await db()).count('outbox');
    },

    /**
     * Drain the outbox through `publish` in FIFO order. Stops at the first
     * failure so a dead network doesn't burn retries; entries are removed
     * only after success, and deletes are batched in ONE transaction
     * (v1 flushed with a per-event transaction). Returns how many were
     * published.
     */
    async flushOutbox(publish) {
      const database = await db();
      const keys = await database.getAllKeys('outbox');

      const deliveredKeys: number[] = [];
      for (const key of keys) {
        const entry = await database.get('outbox', key);
        if (!entry) continue;
        const ok = await publish(entry.event);
        if (!ok) break; // stop at first failure — the rest stay held
        deliveredKeys.push(key);
      }

      if (deliveredKeys.length > 0) {
        const tx = database.transaction('outbox', 'readwrite');
        for (const key of deliveredKeys) void tx.store.delete(key);
        await tx.done;
      }
      return deliveredKeys.length;
    },

    close() {
      void dbPromise?.then((d) => d.close());
      dbPromise = null;
    },
  };
}
