/**
 * publisher.test.ts — port of crawlstr publisher.test.ts (outbox
 * integration, audit finding #3 / contract C-2), adapted to the core's
 * class-based Publisher + CrawlerStorage (fake-indexeddb provides a real
 * IndexedDB so the outbox is tested against actual persistence code).
 *
 * Before the fix, a crawl observation published while offline (or against
 * dead relays) was silently dropped, yet the page stayed marked `fetched`
 * — permanent data loss. Now zero-accept events are persisted and flushed
 * when relays recover.
 */
import 'fake-indexeddb/auto';

import { describe, it, expect, beforeEach } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { Publisher, type PublisherConfig } from './publisher';
import { createIdbStorage, type CrawlerStorage } from './storage';

const RELAYS = ['wss://relay.ditto.pub', 'wss://relay.nos.lol'];

let storage: CrawlerStorage;
let publisher: Publisher;
let relayPublish: (url: string, ev: NostrEvent) => Promise<void>;
let dbCounter = 0;

/** Fake host signer: returns a syntactically valid signed event. */
const fakeSigner = async (event: {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}): Promise<NostrEvent> => ({
  id: 'f'.repeat(56) + Math.random().toString(16).slice(2, 10),
  pubkey: 'a'.repeat(64),
  sig: 'b'.repeat(128),
  ...event,
});

function freshPublisher(overrides: Partial<PublisherConfig> = {}): Publisher {
  storage = createIdbStorage(`crawler-core-test-${++dbCounter}`);
  publisher = new Publisher({
    signer: fakeSigner,
    publish: (url, ev) => relayPublish(url, ev),
    relays: RELAYS,
    storage,
    ...overrides,
  });
  return publisher;
}

/** Publisher transport that rejects every relay. */
const allFail = async (url: string): Promise<void> => {
  throw new Error(`relay down: ${url}`);
};

beforeEach(() => {
  relayPublish = async () => {};
});

describe('publisher outbox integration (fake relays)', () => {
  it('holds the signed event when zero relays accept, then flushes on recovery', async () => {
    const pub = freshPublisher();

    // Phase 1: every relay down.
    relayPublish = allFail;
    const result = await pub.publishIndexObservation({
      url: 'https://example.com/offline-page',
      title: 'Published While Offline',
    });
    expect(result).not.toBeNull();
    expect(result!.delivered).toBe(0);
    expect(result!.normalizedUrl).toBe('https://example.com/offline-page');
    expect(await storage.outboxSize()).toBe(1);

    // Relay health recorded the failures.
    const healthEntries = Object.values(pub.getRelayHealth());
    expect(healthEntries.length).toBeGreaterThan(0);
    expect(healthEntries.every((h) => h.ok === 0 && h.fail > 0)).toBe(true);

    // Phase 2: relays recover — the held event flushes, byte-intact.
    const received: NostrEvent[] = [];
    relayPublish = async (_url, event) => {
      received.push(event);
    };

    const flushed = await pub.flushObservationOutbox();
    expect(flushed).toBe(1);
    expect(await storage.outboxSize()).toBe(0);

    // The same signed event (same id/signature) reached every relay.
    expect(received.length).toBeGreaterThan(1);
    const ids = new Set(received.map((e) => e.id));
    expect(ids.size).toBe(1);
    const event = received[0]!;
    expect(event.kind).toBe(39697);
    expect(event.tags.find(([n]) => n === 'u')?.[1]).toBe('https://example.com/offline-page');
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
  });

  it('does not touch the outbox when at least one relay accepts', async () => {
    const pub = freshPublisher();
    let calls = 0;
    relayPublish = async (url) => {
      calls++;
      if (!url.includes('ditto')) throw new Error('down'); // one relay up
    };
    const result = await pub.publishIndexObservation({
      url: 'https://example.com/live-page',
      title: 'Published While Online',
    });
    expect(calls).toBeGreaterThan(1);
    expect(result!.delivered).toBe(1);
    expect(await storage.outboxSize()).toBe(0);
  });

  it('drops non-positive published claims before the builder (C-1, defense in depth)', async () => {
    const pub = freshPublisher();
    const seen: NostrEvent[] = [];
    relayPublish = async (_url, ev) => {
      seen.push(ev);
    };
    await pub.publishIndexObservation({
      url: 'https://example.com/epoch',
      title: 'Epoch page',
      published: -5, // pre-1970 claim — must NOT reach the wire
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.tags.find(([n]) => n === 'published')).toBeUndefined();
  });

  it('returns null for non-indexable input (empty title)', async () => {
    const pub = freshPublisher();
    const result = await pub.publishIndexObservation({
      url: 'https://example.com/x',
      title: '   ',
    });
    expect(result).toBeNull();
    expect(await storage.outboxSize()).toBe(0);
  });
});
