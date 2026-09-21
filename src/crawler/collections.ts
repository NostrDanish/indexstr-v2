/**
 * Curated URL collections — the reason Indexstr exists.
 *
 * Each collection is a raw SQLite database holding a `linkdatamodel` table
 * (scraped links with titles) plus a `sourcedatamodel` table (categorized
 * source sites/feeds). The loader fetches the database on demand, scans both
 * tables with the minimal SQLite reader (sqlite.ts), normalizes every URL
 * per SIP-01 §7, dedupes, and returns a clean seed list for the crawl queue.
 *
 * Sources, tried in order (first bytes that pass integrity checks win):
 *   1. /collections/<id>.db — same-origin static file (works when deployed;
 *      some dev/preview sandboxes can't serve large binaries)
 *   2. Blossom (content-addressed: blossom.primal.net/<sha256>)
 *   3. The same Blossom blob via the Shakespeare CORS proxy, for networks
 *      that block direct access
 *
 * Blossom blobs are addressed by sha256 and the downloaded bytes are hashed
 * and compared, so any transport is safe. Databases are parsed once and the
 * extracted URL list is cached in IndexedDB — reloading is instant.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { normalizeIndexUrl } from '@sip01/protocol';
import { SqliteReader } from './sqlite';

/** Blossom server hosting the collection blobs (uploaded at build time). */
const BLOSSOM_SERVER = 'https://blossom.primal.net';

/** CORS proxy used as a last-resort transport for the Blossom blob. */
const CORS_PROXY = 'https://proxy.shakespeare.diy/?url=';

/* ------------------------------------------------------------------------ */
/* Registry                                                                  */
/* ------------------------------------------------------------------------ */

export interface UrlCollection {
  /** Stable id — also the local file name: /collections/<id>.db */
  id: string;
  name: string;
  description: string;
  /** Lucide icon key, resolved by the UI. */
  icon: string;
  /** File size in bytes (shown before first load). */
  sizeBytes: number;
  /** SHA-256 of the database file — the Blossom blob id and integrity check. */
  sha256: string;
}

export const COLLECTIONS: UrlCollection[] = [
  {
    id: 'top',
    name: 'Top Sites',
    description: 'High-traffic websites, news aggregators and community threads.',
    icon: 'trophy',
    sizeBytes: 26099712,
    sha256: 'c3f08efa2648519f243b80b7438b2be30fac9c7988294adfde7e81e2e10b1f8e',
  },
  {
    id: 'awesomelists',
    name: 'Awesome Lists',
    description: 'Curated awesome-* lists — the best tools and resources per topic.',
    icon: 'list-checks',
    sizeBytes: 20488192,
    sha256: '8de8953df9e129beb446d775e600dbe24861b40512d2c4c6ff1ca188323d5eb6',
  },
  {
    id: 'feeds',
    name: 'RSS Feeds',
    description: 'RSS and Atom feeds across tech, science, news and culture.',
    icon: 'rss',
    sizeBytes: 18808832,
    sha256: 'afd1be7b2acc2757c1ef60c90fcb9c65c0ad18c28429a243f52bfe04351f0514',
  },
  {
    id: 'music',
    name: 'Music',
    description: 'Artists, labels, streaming pages and music communities.',
    icon: 'music',
    sizeBytes: 10416128,
    sha256: '2a5628fa59315d02e3b146430af9ab03321bd0238fcb0391ec87c2ed1e7d3800',
  },
  {
    id: 'books',
    name: 'Books',
    description: 'Digital libraries, book search engines and reading platforms.',
    icon: 'book-open',
    sizeBytes: 1327104,
    sha256: '5bab5609960bbdebeb68dce4b07e6aef881550d1e01c93c6906d3f0e4cbcd87c',
  },
  {
    id: 'movies',
    name: 'Movies',
    description: 'Film databases, streaming indexes and cinema resources.',
    icon: 'clapperboard',
    sizeBytes: 1204224,
    sha256: '2ee719d71b42cc39cfa1f7958f440f10114bfbf2e6d0243c9b8bad96287ff577',
  },
  {
    id: 'memes',
    name: 'Memes',
    description: 'Meme archives, humor sites and internet culture pages.',
    icon: 'laugh',
    sizeBytes: 1052672,
    sha256: 'c233f7b99541b4b647d7e092ef92cc77e0b820e6515ca0ce66acddbcabb2fb8e',
  },
  {
    id: 'videogames',
    name: 'Video Games',
    description: 'Game databases, stores, mods and gaming communities.',
    icon: 'gamepad-2',
    sizeBytes: 884736,
    sha256: '832b46a3449a015caba5e84e49e19eed71d7de9029640b3d00d3d396385d6c20',
  },
];

/** Ordered download sources for a collection database. */
function collectionSources(collection: UrlCollection): string[] {
  const blossom = `${BLOSSOM_SERVER}/${collection.sha256}`;
  return [
    `/collections/${collection.id}.db`,
    blossom,
    `${CORS_PROXY}${encodeURIComponent(blossom)}`,
  ];
}

/* ------------------------------------------------------------------------ */
/* Types + progress                                                          */
/* ------------------------------------------------------------------------ */

export interface CollectionSample {
  url: string;
  title?: string;
}

export interface CollectionEntries {
  /** Normalized, deduped URLs ready for the crawl queue. */
  urls: string[];
  /** A few titled entries for UI previews. */
  samples: CollectionSample[];
  /** Rows scanned before normalization/dedup. */
  rawCount: number;
}

export type LoadStage = 'downloading' | 'parsing' | 'cached';

export type LoadProgress =
  | { stage: 'downloading'; loaded: number; total: number }
  | { stage: 'parsing'; pages: number; totalPages: number }
  | { stage: 'cached' };

/* ------------------------------------------------------------------------ */
/* Extraction cache (IndexedDB)                                              */
/* ------------------------------------------------------------------------ */

interface CollectionsDB extends DBSchema {
  'collection-cache': {
    key: string;
    value: {
      id: string;
      urls: string[];
      samples: CollectionSample[];
      rawCount: number;
      extractedAt: number;
    };
  };
}

let cacheDb: IDBPDatabase<CollectionsDB> | null = null;

async function getCacheDb(): Promise<IDBPDatabase<CollectionsDB>> {
  if (cacheDb) return cacheDb;
  cacheDb = await openDB<CollectionsDB>('indexstr-collections', 1, {
    upgrade(database) {
      database.createObjectStore('collection-cache', { keyPath: 'id' });
    },
  });
  return cacheDb;
}

export async function getCachedCollection(id: string): Promise<CollectionEntries | null> {
  try {
    const db = await getCacheDb();
    const hit = await db.get('collection-cache', id);
    return hit ? { urls: hit.urls, samples: hit.samples, rawCount: hit.rawCount } : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ */
/* Loader                                                                    */
/* ------------------------------------------------------------------------ */

/** Download one database file, reporting byte progress. */
async function fetchDatabase(
  collection: UrlCollection,
  url: string,
  onProgress?: (progress: LoadProgress) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${collection.id}.db`);

  const total = Number(response.headers.get('content-length')) || collection.sizeBytes;
  if (!response.body) return response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ stage: 'downloading', loaded, total });
  }
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

const SQLITE_MAGIC = 'SQLite format 3';

/**
 * Reject anything that isn't byte-for-byte the expected database:
 * checks the SQLite magic first (cheap), then the full SHA-256 — the
 * Blossom blob id — so the content is trusted regardless of transport.
 */
async function assertIntegrity(buffer: ArrayBuffer, expectedSha256: string): Promise<void> {
  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, SQLITE_MAGIC.length));
  if (head !== SQLITE_MAGIC) {
    throw new Error('Not a SQLite file (bad magic)');
  }
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== expectedSha256) {
    throw new Error('Collection checksum mismatch');
  }
}

/**
 * Fetch and parse a collection database. Extraction results are cached in
 * IndexedDB; pass `fresh: true` to force a re-download + re-parse.
 */
export async function loadCollectionEntries(
  collection: UrlCollection,
  onProgress?: (progress: LoadProgress) => void,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<CollectionEntries> {
  if (!fresh) {
    const cached = await getCachedCollection(collection.id);
    if (cached && cached.urls.length > 0) {
      onProgress?.({ stage: 'cached' });
      return cached;
    }
  }

  // 1. Download the database from the first source that delivers the exact
  //    expected bytes (SQLite magic + sha256 must match — HTTP 200 is not
  //    proof, some hosts answer with an HTML fallback page).
  let buffer: ArrayBuffer | null = null;
  let lastError: unknown = null;

  for (const source of collectionSources(collection)) {
    try {
      const candidate = await fetchDatabase(collection, source, onProgress);
      await assertIntegrity(candidate, collection.sha256);
      buffer = candidate;
      break;
    } catch (error) {
      console.debug(`[Collections] Source failed (${source}):`, error);
      lastError = error;
    }
  }

  if (!buffer) {
    throw lastError instanceof Error
      ? lastError
      : new Error('All collection sources failed');
  }

  // 2. Parse: full-scan linkdatamodel (scraped links) and sourcedatamodel
  //    (categorized sources) and merge.
  const db = new SqliteReader(buffer);
  const tables = new Map(db.listTables().map((t) => [t.name, t]));

  const seen = new Set<string>();
  const urls: string[] = [];
  const samples: CollectionSample[] = [];
  let rawCount = 0;

  const addUrl = (raw: unknown, title: unknown, description: unknown): void => {
    if (typeof raw !== 'string' || raw.length === 0) return;
    rawCount++;

    // Clean scraper artifacts: "URL:<link>" prefixes and literal whitespace
    // (a space means the scraper glued an error message onto the URL).
    let candidate = raw.trim();
    if (/^url:/i.test(candidate)) candidate = candidate.slice(4).trim();
    if (/\s/.test(candidate) || candidate.length < 10) return;

    const normalized = normalizeIndexUrl(candidate);
    if (!normalized || normalized.length > 2048) return;
    if (!isIndexableHost(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    urls.push(normalized);

    if (
      samples.length < 8 &&
      typeof title === 'string' &&
      title.trim().length > 2 &&
      !/\b(response is invalid|error|not found)\b/i.test(title)
    ) {
      samples.push({
        url: normalized,
        title: title.trim().slice(0, 120) || undefined,
      });
    }
    void description; // Titles are enough for previews; content comes from crawling.
  };

  const progress = (pages: number, totalPages: number) =>
    onProgress?.({ stage: 'parsing', pages, totalPages });

  const links = tables.get('linkdatamodel');
  if (links) {
    const cols = SqliteReader.tableColumns(links.sql);
    const iLink = cols.indexOf('link');
    const iTitle = cols.indexOf('title');
    const iDesc = cols.indexOf('description');
    if (iLink >= 0) {
      await db.scanTable(
        links.rootPage,
        (values) => addUrl(values[iLink], iTitle >= 0 ? values[iTitle] : null, iDesc >= 0 ? values[iDesc] : null),
        progress,
      );
    }
  }

  const sources = tables.get('sourcedatamodel');
  if (sources) {
    const cols = SqliteReader.tableColumns(sources.sql);
    const iUrl = cols.indexOf('url');
    const iTitle = cols.indexOf('title');
    if (iUrl >= 0) {
      await db.scanTable(
        sources.rootPage,
        (values) => addUrl(values[iUrl], iTitle >= 0 ? values[iTitle] : null, null),
        progress,
      );
    }
  }

  // 3. Cache the extraction so the next load is instant.
  try {
    const cache = await getCacheDb();
    await cache.put('collection-cache', {
      id: collection.id,
      urls,
      samples,
      rawCount,
      extractedAt: Date.now(),
    });
  } catch {
    // Cache is best-effort — seeding still works without it.
  }

  return { urls, samples, rawCount };
}

/**
 * Drop URLs a browser crawler can never reach: localhost, private ranges,
 * dotless hosts, and non-clearnet TLDs (.onion/.i2p resolve nowhere here).
 */
function isIndexableHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (!host.includes('.')) return false;
    if (host === 'localhost' || host.endsWith('.local')) return false;
    if (host.endsWith('.onion') || host.endsWith('.i2p')) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      if (/^(127\.|10\.|192\.168\.|0\.)/.test(host)) return false;
      const [, second] = host.split('.').map(Number);
      if (host.startsWith('172.') && second >= 16 && second <= 31) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------ */
/* Loaded-state bookkeeping (localStorage)                                   */
/* ------------------------------------------------------------------------ */

const LS_KEY = 'indexstr:collection-state:v1';

export interface CollectionState {
  /** URLs queued the last time this collection was loaded. */
  queued: number;
  loadedAt: number;
}

export function getCollectionStates(): Record<string, CollectionState> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, CollectionState>) : {};
  } catch {
    return {};
  }
}

export function markCollectionLoaded(id: string, queued: number): Record<string, CollectionState> {
  const states = getCollectionStates();
  states[id] = { queued, loadedAt: Date.now() };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(states));
  } catch {
    // Non-critical.
  }
  return states;
}
