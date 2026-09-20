import { describe, expect, test } from 'vitest';
import {
  CROSS_SHARD_SAMPLING,
  SHARD_COUNT,
  fnv1a32,
  nodeShard,
  shardLabel,
  urlShard,
} from './sharding';

describe('fnv1a32', () => {
  test('matches the canonical FNV-1a offset basis for empty input', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
  });

  test('is deterministic', () => {
    expect(fnv1a32('https://example.com/')).toBe(fnv1a32('https://example.com/'));
  });

  test('differs for slightly different inputs', () => {
    expect(fnv1a32('https://example.com/a')).not.toBe(fnv1a32('https://example.com/b'));
  });
});

describe('urlShard', () => {
  test('always lands inside the shard space', () => {
    for (let i = 0; i < 500; i++) {
      const shard = urlShard(`https://example.com/page/${i}`);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(SHARD_COUNT);
    }
  });

  test('is deterministic — the property the whole network relies on', () => {
    const url = 'https://bitcoin.org/en/faq';
    expect(urlShard(url)).toBe(urlShard(url));
  });

  test('distributes roughly uniformly across 256 shards', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      seen.add(urlShard(`https://example.org/item?id=${i}`));
    }
    // With 5000 draws over 256 buckets we should cover nearly all buckets.
    expect(seen.size).toBeGreaterThan(230);
  });
});

describe('nodeShard', () => {
  test('derives from the first pubkey byte', () => {
    expect(nodeShard('a7' + '0'.repeat(62))).toBe(0xa7);
    expect(nodeShard('00' + 'f'.repeat(62))).toBe(0x00);
    expect(nodeShard('ff' + '0'.repeat(62))).toBe(0xff);
  });

  test('two different nodes generally get different home shards', () => {
    // The core non-duplication property: distinct identities → distinct work.
    const a = nodeShard('c45041618951bb6012ac23f5cdf3d740465f2d640be841fd9bb1d0733370cd3c');
    const b = nodeShard('0000000000000000000000000000000000000000000000000000000000000001');
    expect(a).not.toBe(b);
  });
});

describe('shardLabel', () => {
  test('formats as two uppercase hex chars', () => {
    expect(shardLabel(0)).toBe('00');
    expect(shardLabel(167)).toBe('A7');
    expect(shardLabel(255)).toBe('FF');
  });
});

describe('scheduler constants', () => {
  test('cross-shard sampling stays a minority of work', () => {
    expect(CROSS_SHARD_SAMPLING).toBeGreaterThan(0);
    expect(CROSS_SHARD_SAMPLING).toBeLessThan(0.5);
  });
});

describe('published wire vectors (blueprint §5 — fnv1a32_utf16, fixed comment)', () => {
  // Computed with the deployed algorithm; non-ASCII inputs exercise the
  // UTF-16 high-byte folding and surrogate-pair handling. Any change to
  // these values means a wire-breaking reshuffle of the shard space.
  test('fixed vectors', () => {
    expect(urlShard('https://example.com/')).toBe(224);
    expect(urlShard('https://example.com/page')).toBe(94);
    expect(urlShard('https://bücher.de/suche?q=tee')).toBe(130); // non-ASCII
    expect(urlShard('https://example.com/😀')).toBe(250); // surrogate pair
    expect(urlShard('https://sub.example.co.uk/a/b?c=d')).toBe(30);
  });
});
