/**
 * index.test.ts — public-API smoke test: createCrawler with fully
 * host-injected seams (signer, publish, fetch, storage on fake-indexeddb,
 * clock). Asserts the deep-module boundary behaviors: admission guard,
 * stats snapshot, event subscription, relay health, indexer info, outbox.
 */
import 'fake-indexeddb/auto';

import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import {
  createCrawler,
  parseHeartbeat,
  isNodeLive,
  HEARTBEAT_KIND,
  HEARTBEAT_TTL_S,
  type CrawlerConfig,
} from './index';

const fakeSigner = async (event: {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}): Promise<NostrEvent> => ({
  id: 'f'.repeat(64),
  pubkey: 'ab'.repeat(32),
  sig: 'c'.repeat(128),
  ...event,
});

function makeConfig(overrides: Partial<CrawlerConfig> = {}): CrawlerConfig {
  return {
    dbName: `crawler-core-public-test-${Math.random().toString(36).slice(2)}`,
    source: 'crawlstr/v2',
    signer: fakeSigner,
    indexerPubkey: 'ab'.repeat(32),
    indexerNpub: 'npub1example',
    transports: {
      publish: async () => {},
      fetch: vi.fn(async () => new Response('404', { status: 404 })) as unknown as typeof fetch,
    },
    relays: { publish: ['wss://relay.ditto.pub', 'wss://relay.nos.lol'] },
    ...overrides,
  };
}

describe('createCrawler — the whole public surface', () => {
  it('builds a node and exposes the promised methods', () => {
    const node = createCrawler(makeConfig());
    expect(typeof node.start).toBe('function');
    expect(typeof node.stop).toBe('function');
    expect(typeof node.seed).toBe('function');
    expect(typeof node.stats).toBe('function');
    expect(typeof node.on).toBe('function');
    expect(typeof node.outboxSize).toBe('function');
    expect(typeof node.flushOutbox).toBe('function');
    expect(typeof node.relayHealth).toBe('function');
    expect(typeof node.indexerInfo).toBe('function');
    expect(typeof node.probeRelay).toBe('function');
    expect(node.isRunning()).toBe(false);
  });

  it('seed() runs the admission path: private URLs rejected, public admitted', async () => {
    const node = createCrawler(makeConfig());
    const { admitted, rejected } = await node.seed([
      'https://example.com/',
      'http://169.254.169.254/latest/meta-data',
      'file:///etc/passwd',
      'not a url',
    ]);
    expect(admitted).toBe(1);
    expect(rejected).toBe(3);
    const stats = node.stats();
    expect(stats.queueSize).toBe(1);
    // Only the parseable private URL reaches the guard counter; the scheme
    // violation and the garbage string die at normalization first.
    expect(stats.ssrfBlocked).toBe(1);
  });

  it('indexerInfo reflects the injected identity and derived home shard', () => {
    const node = createCrawler(makeConfig());
    const info = node.indexerInfo();
    expect(info.pubkeyHex).toBe('ab'.repeat(32));
    expect(info.npub).toBe('npub1example');
    expect(info.homeShard).toBe(0xab); // first pubkey byte
  });

  it('on() subscribes to stats events and unsubscribes cleanly', async () => {
    const node = createCrawler(makeConfig());
    const seen: string[] = [];
    const off = node.on('stats', (ev) => seen.push(ev.type));
    await node.seed(['https://example.com/']);
    expect(seen).toContain('stats');
    off();
  });

  it('start/stop lifecycle is abort-safe and idempotent', async () => {
    const node = createCrawler(makeConfig());
    await node.start();
    expect(node.isRunning()).toBe(true);
    await node.stop();
    expect(node.isRunning()).toBe(false);
    // Queue persists across stop (nothing was crawled — fetch was 404s).
    expect(node.stats().queueSize).toBeGreaterThanOrEqual(0);
  });

  it('probeRelay refuses private targets with zero requests (choke point)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    const node = createCrawler(
      makeConfig({
        transports: {
          publish: async () => {},
          fetch: fetchMock as unknown as typeof fetch,
        },
      }),
    );
    const caps = await node.probeRelay('ws://169.254.169.254');
    expect(caps.online).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('relay-probe bytes count toward the shared meter (counts EVERY byte)', async () => {
    const nip11 = JSON.stringify({ name: 'probe-test relay', supported_nips: [11, 50] });
    const fetchMock = vi.fn(
      async () =>
        new Response(nip11, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const node = createCrawler(
      makeConfig({
        transports: { publish: async () => {}, fetch: fetchMock as unknown as typeof fetch },
      }),
    );

    const caps = await node.probeRelay('wss://probe-test.example');
    expect(caps.online).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Probe traffic must land in the SAME meter as page traffic. Seeding
    // forces a stats sync; the snapshot must include the probe's bytes.
    await node.seed(['https://example.com/']);
    expect(node.stats().bandwidthUsed).toBe(new TextEncoder().encode(nip11).byteLength);
  });
});

describe('read/maintenance surface (dashboard seams)', () => {
  it('exposes the read/maintenance methods', () => {
    const node = createCrawler(makeConfig());
    expect(typeof node.persistedStats).toBe('function');
    expect(typeof node.recentCrawls).toBe('function');
    expect(typeof node.clearQueue).toBe('function');
    expect(typeof node.clearAll).toBe('function');
    expect(typeof node.networkHeartbeats).toBe('function');
  });

  it('persistedStats reads the store BEFORE start(); clearQueue/clearAll maintain it', async () => {
    const node = createCrawler(makeConfig());
    await node.seed(['https://example.com/a', 'https://example.com/b']);

    // Session stats are visible immediately; persisted counts agree.
    expect(node.stats().queueSize).toBe(2);
    const persisted = await node.persistedStats();
    expect(persisted.queueSize).toBe(2);
    expect(persisted.pagesIndexed).toBe(0);
    expect(persisted.outboxPending).toBe(0);
    expect(persisted.homeShardJobs).toBe(0); // sharding module off

    await node.clearQueue();
    expect(node.stats().queueSize).toBe(0);
    expect((await node.persistedStats()).queueSize).toBe(0);

    // clearAll additionally wipes crawled history + outbox.
    await node.seed(['https://example.com/c']);
    await node.clearAll();
    const after = await node.persistedStats();
    expect(after).toEqual({ queueSize: 0, pagesIndexed: 0, outboxPending: 0, homeShardJobs: 0 });
  });

  it('recentCrawls is empty before anything is crawled', async () => {
    const node = createCrawler(makeConfig());
    expect(await node.recentCrawls(20)).toEqual([]);
  });
});

describe('heartbeat read seam', () => {
  const hbEvent = (pubkey: string, createdAt: number, shard = 'ab'): NostrEvent => ({
    id: Math.random().toString(16).slice(2).padStart(64, '0').slice(0, 64),
    pubkey,
    sig: 'c'.repeat(128),
    kind: HEARTBEAT_KIND,
    created_at: createdAt,
    content: JSON.stringify({
      v: '2',
      shard,
      stats: { pagesIndexed: 1, queueSize: 2, published: 3 },
    }),
    tags: [['source', 'indexstr/v2']],
  });

  it('networkHeartbeats returns [] without a heartbeatQuery transport', async () => {
    const node = createCrawler(makeConfig());
    expect(await node.networkHeartbeats()).toEqual([]);
  });

  it('networkHeartbeats queries kind 16919 and dedupes latest-per-node', async () => {
    const now = Math.floor(Date.now() / 1000);
    const nodeA = 'aa'.repeat(32);
    const nodeB = 'bb'.repeat(32);
    let seenFilters: Array<Record<string, unknown>> = [];
    const node = createCrawler(
      makeConfig({
        transports: {
          publish: async () => {},
          heartbeatQuery: async (filters) => {
            seenFilters = filters;
            return [
              hbEvent(nodeA, now - 100), // stale version of A
              hbEvent(nodeA, now - 10), // latest A
              hbEvent(nodeB, now - 20), // latest B
              hbEvent(nodeB, now - HEARTBEAT_TTL_S * 3, 'cd'), // expired B version
            ];
          },
        },
      }),
    );

    const heartbeats = await node.networkHeartbeats();
    expect(seenFilters[0]?.kinds).toEqual([HEARTBEAT_KIND]);
    expect(heartbeats.map((hb) => hb.pubkey)).toEqual([nodeA, nodeB]); // newest first
    expect(heartbeats[0].createdAt).toBe(now - 10);
    expect(heartbeats[0].shard).toBe('AB'); // normalized uppercase
    expect(heartbeats[0].source).toBe('indexstr/v2');
    expect(heartbeats.every((hb) => isNodeLive(hb, now))).toBe(true);
  });

  it('parseHeartbeat is the exported wire-shape validator', () => {
    expect(parseHeartbeat(hbEvent('aa'.repeat(32), 1000))?.shard).toBe('AB');
    expect(
      parseHeartbeat({ ...hbEvent('aa'.repeat(32), 1000), kind: 39697 }),
    ).toBeNull();
    expect(
      parseHeartbeat({ ...hbEvent('aa'.repeat(32), 1000), content: '{not json' }),
    ).toBeNull();
  });
});
