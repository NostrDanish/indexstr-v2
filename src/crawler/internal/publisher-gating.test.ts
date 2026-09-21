/**
 * publisher-gating.test.ts — port of crawlstr publisher-gating.test.ts.
 * The health gate: a relay that has failed 8+ times this session without a
 * single success is skipped (auto-rotation); one success re-enables it.
 * With the class-based Publisher, instance state replaces v1's module
 * globals — a fresh Publisher starts clean.
 */
import 'fake-indexeddb/auto';

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { Publisher } from './publisher';
import { createIdbStorage } from './storage';

const RELAYS = ['wss://relay.ditto.pub', 'wss://relay.nos.lol'];

const fakeSigner = async (event: {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}): Promise<NostrEvent> => ({
  id: Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64),
  pubkey: 'a'.repeat(64),
  sig: 'b'.repeat(128),
  ...event,
});

describe('relay health gating (publisher.ts)', () => {
  it('gates a relay after 8 failures with no success; one success re-enables', async () => {
    const storage = createIdbStorage('crawler-core-gating-test');
    const attempts = new Map<string, number>();
    const pub = new Publisher({
      signer: fakeSigner,
      relays: RELAYS,
      storage,
      publish: async (url) => {
        attempts.set(url, (attempts.get(url) ?? 0) + 1);
        throw new Error('always down');
      },
    });

    const publish = (i: number) =>
      pub.publishIndexObservation({ url: `https://example.com/gated-${i}`, title: `Gated ${i}` });

    // Eight all-fail publishes → every relay reaches RELAY_FAIL_GATE.
    for (let i = 0; i < 8; i++) await publish(i);
    const health = pub.getRelayHealth();
    expect(Object.values(health).every((h) => h.ok === 0 && h.fail === 8)).toBe(true);

    // Ninth publish: all relays gated — zero attempts, event straight to outbox.
    const outboxBefore = await storage.outboxSize();
    const result = await publish(8);
    for (const count of attempts.values()) expect(count).toBe(8);
    expect(result!.delivered).toBe(0);
    expect(await storage.outboxSize()).toBe(outboxBefore + 1);

    // A relay with a success on record is never gated.
    expect(Object.values(pub.getRelayHealth()).every((h) => h.ok === 0)).toBe(true);
  });
});
