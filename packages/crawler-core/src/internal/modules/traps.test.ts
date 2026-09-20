import { describe, expect, test } from 'vitest';
import { isLikelyCrawlTrap, DomainIntakeGuard, IndexerIntakeGuard } from './traps';

describe('isLikelyCrawlTrap', () => {
  test('normal pages pass', () => {
    expect(isLikelyCrawlTrap('https://example.com/')).toBe(false);
    expect(isLikelyCrawlTrap('https://example.com/blog/my-post')).toBe(false);
    expect(isLikelyCrawlTrap('https://en.wikipedia.org/wiki/Nostr')).toBe(false);
    expect(isLikelyCrawlTrap('https://github.com/nostr/nips')).toBe(false);
    // HN-style numeric ids are fine (7 digits < 9-digit trap threshold)
    expect(isLikelyCrawlTrap('https://news.ycombinator.com/item?id=39697675')).toBe(false);
  });

  test('session-state query keys are traps', () => {
    expect(isLikelyCrawlTrap('https://example.com/page?sid=abc123')).toBe(true);
    expect(isLikelyCrawlTrap('https://example.com/page?PHPSESSID=xyz')).toBe(true);
  });

  test('query-param explosion is a trap', () => {
    expect(isLikelyCrawlTrap('https://example.com/f?a=1&b=2&c=3&d=4&e=5&f=6&g=7')).toBe(true);
  });

  test('cart/checkout/calendar segments are traps', () => {
    expect(isLikelyCrawlTrap('https://shop.example.com/cart/add/42')).toBe(true);
    expect(isLikelyCrawlTrap('https://example.com/checkout/step/1')).toBe(true);
    expect(isLikelyCrawlTrap('https://example.com/calendar/2026/08')).toBe(true);
  });

  test('repeating segment loop is a trap', () => {
    expect(isLikelyCrawlTrap('https://example.com/a/a/a/')).toBe(true);
    expect(isLikelyCrawlTrap('https://example.com/x/x/x/1')).toBe(true);
  });

  test('huge numeric path segments are traps', () => {
    expect(isLikelyCrawlTrap('https://example.com/page/123456789')).toBe(true);
  });

  test('extreme depth is a trap', () => {
    expect(isLikelyCrawlTrap('https://example.com/a/b/c/d/e/f/g/h/i')).toBe(true);
  });

  test('invalid URL is treated as a trap (fail closed)', () => {
    expect(isLikelyCrawlTrap('not-a-url')).toBe(true);
  });
});

describe('DomainIntakeGuard', () => {
  test('allows up to the cap, then blocks', () => {
    const guard = new DomainIntakeGuard(3);
    expect(guard.allow('https://example.com/a')).toBe(true);
    expect(guard.allow('https://example.com/b')).toBe(true);
    expect(guard.allow('https://example.com/c')).toBe(true);
    expect(guard.allow('https://example.com/d')).toBe(false);
    // Other domains are unaffected
    expect(guard.allow('https://other.com/a')).toBe(true);
  });
});

describe('IndexerIntakeGuard (Sybil cap)', () => {
  test('caps one flooding pubkey without touching others', () => {
    const guard = new IndexerIntakeGuard(3);
    const flood = 'aa'.repeat(32);
    const honest = 'bb'.repeat(32);

    expect(guard.allow(flood)).toBe(true);
    expect(guard.allow(flood)).toBe(true);
    expect(guard.allow(flood)).toBe(true);
    expect(guard.allow(flood)).toBe(false); // capped

    expect(guard.allow(honest)).toBe(true);
    expect(guard.indexerCount).toBe(2);
  });

  test('a 10k-domain × N-url flood still hits the indexer cap', () => {
    const guard = new IndexerIntakeGuard(100);
    const attacker = 'cc'.repeat(32);
    let accepted = 0;
    for (let d = 0; d < 10_000; d++) {
      for (let u = 0; u < 200; u++) {
        if (guard.allow(attacker)) accepted++;
      }
    }
    expect(accepted).toBe(100); // two million candidate URLs → 100 accepted
  });
});
