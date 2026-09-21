import { describe, expect, test } from 'vitest';
import { deriveTopics, classifyDocType, enrichPage } from './enrich';
import type { ParsedPage } from '../types';

function page(overrides: Partial<ParsedPage>): ParsedPage {
  return {
    title: '',
    description: '',
    text: '',
    language: 'en',
    links: [],
    wordCount: 100,
    keywords: [],
    jsonLdTypes: [],
    headings: [],
    feeds: [], // union type: crawlstr parser fields
    canonical: '',
    ...overrides,
  };
}

describe('deriveTopics', () => {
  test('title evidence clears the threshold', () => {
    const topics = deriveTopics(
      page({ title: 'Bitcoin Lightning Network Guide' }),
      'https://example.com/guide',
    );
    expect(topics).toContain('bitcoin');
    expect(topics).toContain('lightning');
  });

  test('meta keywords are strong evidence (source tags inform derivation)', () => {
    const topics = deriveTopics(
      page({ title: 'Welcome', keywords: ['Retro Gaming', 'Emulation'] }),
      'https://example.com/',
    );
    expect(topics).toContain('retro-gaming');
  });

  test('normalization: Bitcoin / BITCOIN / bitcoin collapse to one tag', () => {
    const topics = deriveTopics(
      page({ title: 'BITCOIN news', description: 'All about Bitcoin today' }),
      'https://example.com/x',
    );
    expect(topics.filter((t) => t === 'bitcoin')).toHaveLength(1);
  });

  test('a weak single mention does not tag', () => {
    const topics = deriveTopics(
      page({
        title: 'Totally unrelated page',
        description: 'not even once',
        // only the URL hints at it — weight 1, below threshold
      }),
      'https://example.com/bitcoin',
    );
    expect(topics).not.toContain('bitcoin');
  });

  test('no false positives on unrelated content', () => {
    const topics = deriveTopics(
      page({
        title: 'Grandma\'s Apple Pie Recipe',
        description: 'Flour, sugar, apples, cinnamon.',
        keywords: ['recipe', 'pie'],
      }),
      'https://example.com/recipe',
    );
    expect(topics).toContain('food');
    expect(topics).not.toContain('bitcoin');
    expect(topics).not.toContain('nostr');
  });

  test('caps at 8 topics', () => {
    const topics = deriveTopics(
      page({
        title: 'Bitcoin privacy nostr tor vpn cryptography security ai linux rust python',
        description:
          'gaming music movies memes science space physics mathematics history philosophy',
      }),
      'https://example.com/x',
    );
    expect(topics.length).toBeLessThanOrEqual(8);
  });

  test('deterministic — same page, same tags (verifiable across nodes)', () => {
    const input = page({ title: 'Nostr protocol tutorial', keywords: ['nostr', 'relay'] });
    expect(deriveTopics(input, 'https://example.com/t')).toEqual(
      deriveTopics(input, 'https://example.com/t'),
    );
  });
});

describe('classifyDocType', () => {
  test('JSON-LD NewsArticle → news', () => {
    expect(
      classifyDocType(page({ jsonLdTypes: ['NewsArticle'] }), 'https://example.com/x'),
    ).toBe('news');
  });

  test('og:type article → article', () => {
    expect(classifyDocType(page({ ogType: 'article' }), 'https://example.com/x')).toBe('article');
  });

  test('og:type video.* → video', () => {
    expect(classifyDocType(page({ ogType: 'video.other' }), 'https://example.com/x')).toBe('video');
  });

  test('github repo URL → repository', () => {
    expect(classifyDocType(page({}), 'https://github.com/nostr/nips')).toBe('repository');
  });

  test('/wiki/ path → wiki', () => {
    expect(classifyDocType(page({}), 'https://en.wikipedia.org/wiki/Nostr')).toBe('wiki');
  });

  test('root path → homepage', () => {
    expect(classifyDocType(page({}), 'https://example.com/')).toBe('homepage');
  });

  test('published timestamp + /blog path → article', () => {
    expect(
      classifyDocType(page({ published: 1786200000 }), 'https://example.com/blog/my-post'),
    ).toBe('article');
  });

  test('unknown shape falls back to page', () => {
    expect(classifyDocType(page({}), 'https://example.com/some/random-thing')).toBe('page');
  });
});

describe('enrichPage', () => {
  test('returns topics, docType, and source keywords', () => {
    const result = enrichPage(
      page({
        title: 'Self-hosting your Bitcoin node',
        keywords: ['bitcoin', 'node'],
        jsonLdTypes: ['Article'],
      }),
      'https://example.com/blog/node',
    );
    expect(result.topics).toContain('bitcoin');
    expect(result.topics).toContain('selfhosting');
    expect(result.docType).toBe('article');
    expect(result.sourceKeywords).toEqual(['bitcoin', 'node']);
  });
});
