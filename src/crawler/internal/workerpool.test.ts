/**
 * workerpool.test.ts — union parser tests: crawlstr parser.test.ts (C-1
 * end-to-end clamp via the real @sip01/protocol builder) + indexstr parser
 * fields (feeds, canonical, og:type, JSON-LD, headings, keywords).
 */
import { describe, it, expect } from 'vitest';
import { buildIndexEvent } from '@sip01/protocol';
import { parseHTML } from 'linkedom';

import {
  InlineProcessor,
  needsMainThreadParse,
  parsePage,
  parsePageFromDocument,
  processInline,
  WorkerPool,
} from './workerpool';
import { parseFeed } from './modules/discovery';

/**
 * End-to-end clamp for SIP-01 finding C-1: page/feed-claimed dates that are
 * non-positive (pre-1970) must be dropped at the extraction layer, so the
 * event builder never sees — let alone emits — a negative `published` tag
 * that validating relays would reject wholesale.
 */

const page = (meta: string) => `<!doctype html><html><head>
  <title>Test Page</title>
  ${meta}
  </head><body><p>${'word '.repeat(20)}</p></body></html>`;

describe('C-1 end-to-end: pre-1970 dates never reach the wire', () => {
  it('parser drops a pre-1970 article:published_time', () => {
    const parsed = parsePage(
      page('<meta property="article:published_time" content="1965-03-15T00:00:00Z">'),
      'https://example.com/post',
    );
    expect(parsed.published).toBeUndefined();
  });

  it('parser keeps a normal post-1970 publication date', () => {
    const parsed = parsePage(
      page('<meta property="article:published_time" content="2024-06-01T12:00:00Z">'),
      'https://example.com/post',
    );
    expect(parsed.published).toBe(Math.floor(new Date('2024-06-01T12:00:00Z').getTime() / 1000));
  });

  it('parser output feeds the builder: no published tag end-to-end', async () => {
    const parsed = parsePage(
      page('<meta property="article:published_time" content="1900-01-01">'),
      'https://example.com/post',
    );
    const event = await buildIndexEvent({
      url: 'https://example.com/post',
      title: parsed.title,
      description: parsed.description,
      published: parsed.published,
    });
    expect(event).not.toBeNull();
    expect(event!.tags.find(([n]) => n === 'published')).toBeUndefined();
  });

  it('builder still refuses a negative date even if a caller bypasses the parser', async () => {
    const event = await buildIndexEvent({
      url: 'https://example.com/post',
      title: 'Test Page',
      published: -1,
    });
    expect(event!.tags.find(([n]) => n === 'published')).toBeUndefined();
  });

  it('Atom feed entries drop pre-1970 <published> claims', () => {
    const atom = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Example Feed</title>
        <entry>
          <title>Old Post</title>
          <link rel="alternate" href="https://example.com/old" />
          <published>1955-11-12T00:00:00Z</published>
        </entry>
        <entry>
          <title>New Post</title>
          <link rel="alternate" href="https://example.com/new" />
          <published>2024-06-01T12:00:00Z</published>
        </entry>
      </feed>`;
    const feed = parseFeed(atom, 'https://example.com/feed.xml');
    expect(feed).not.toBeNull();
    const old = feed!.entries.find((e) => e.title === 'Old Post');
    const recent = feed!.entries.find((e) => e.title === 'New Post');
    expect(old!.published).toBeUndefined();
    expect(recent!.published).toBe(Math.floor(new Date('2024-06-01T12:00:00Z').getTime() / 1000));
  });

  it('RSS items drop pre-1970 <pubDate> claims', () => {
    const rss = `<?xml version="1.0"?>
      <rss version="2.0"><channel>
        <title>Example RSS</title>
        <item>
          <title>Ancient Item</title>
          <link>https://example.com/ancient</link>
          <pubDate>Mon, 01 Jan 1900 00:00:00 GMT</pubDate>
        </item>
      </channel></rss>`;
    const feed = parseFeed(rss, 'https://example.com/rss.xml');
    expect(feed).not.toBeNull();
    expect(feed!.entries[0]!.published).toBeUndefined();
  });
});

describe('parsePage — union parser fields', () => {
  it('extracts feeds, canonical, og:type, JSON-LD types, headings, keywords', () => {
    const parsed = parsePage(
      `<!doctype html><html lang="en"><head>
        <title>Union Page</title>
        <meta name="description" content="A union test page">
        <meta name="keywords" content="nostr, censorship resistance, x">
        <meta property="og:type" content="article">
        <meta property="og:image" content="/img/cover.png">
        <link rel="canonical" href="https://example.com/canonical">
        <link rel="alternate" type="application/rss+xml" href="/feed.xml">
        <script type="application/ld+json">{"@type":"Article","author":{"@type":"Person"}}</script>
      </head><body>
        <h1>Main Heading Here</h1>
        <main><p>${'content '.repeat(50)}</p><a href="/next">next</a></main>
      </body></html>`,
      'https://example.com/page',
    );
    expect(parsed.title).toBe('Union Page');
    expect(parsed.feeds).toEqual([
      { url: 'https://example.com/feed.xml', kind: 'rss' },
    ]);
    expect(parsed.canonical).toBe('https://example.com/canonical');
    expect(parsed.ogType).toBe('article');
    expect(parsed.jsonLdTypes).toContain('Article');
    // v1 parity: only top-level + @graph @types are collected, not nested.
    expect(parsed.jsonLdTypes).not.toContain('Person');
    expect(parsed.headings).toContain('Main Heading Here');
    expect(parsed.keywords).toEqual(['nostr', 'censorship resistance']);
    expect(parsed.image).toBe('https://example.com/img/cover.png');
    expect(parsed.links).toContain('https://example.com/next');
    expect(parsed.wordCount).toBeGreaterThan(40);
  });
});

describe('worker pool (P3 — parse/hash/enrich off the main thread)', () => {
  const UNION_PAGE = `<!doctype html><html lang="en"><head>
    <title>Union Page</title>
    <meta name="description" content="A union test page">
    <meta name="keywords" content="nostr, censorship resistance, x">
    <meta property="og:type" content="article">
    <meta property="og:image" content="/img/cover.png">
    <meta property="article:published_time" content="2024-06-01T12:00:00Z">
    <link rel="canonical" href="https://example.com/canonical">
    <link rel="alternate" type="application/rss+xml" href="/feed.xml">
    <script type="application/ld+json">{"@type":"Article","author":{"@type":"Person"}}</script>
  </head><body>
    <h1>Main Heading Here</h1>
    <main><p>${'content '.repeat(50)}</p><a href="/next">next</a></main>
  </body></html>`;

  /** The worker's parse path, run in-process (linkedom works in bare Node). */
  const parseViaLinkedom = (html: string, baseUrl: string) =>
    parsePageFromDocument(parseHTML(html).document as unknown as Document, baseUrl);

  it('linkedom parse is BYTE-IDENTICAL to DOMParser on all ParsedPage fields', () => {
    const viaDom = parsePage(UNION_PAGE, 'https://example.com/page');
    const viaLinkedom = parseViaLinkedom(UNION_PAGE, 'https://example.com/page');
    expect(viaLinkedom).toEqual(viaDom);
    // Spot-check the load-bearing fields.
    expect(viaLinkedom.title).toBe('Union Page');
    expect(viaLinkedom.published).toBeGreaterThan(0);
    expect(viaLinkedom.links).toContain('https://example.com/next');
    expect(viaLinkedom.wordCount).toBeGreaterThan(40);
  });

  it('linkedom parity holds on malformed/CJK/entity soup', () => {
    const messy = `<!doctype html><html lang="ja"><head><title>テスト &amp; ページ</title>
      <meta name=description content="CJK 本文 &lt;ok&gt;">
      </head><body><div><p>未閉鎖タグ<p>次の段落 😀‍👍 éèê
      <main><p>${'内容 '.repeat(30)}</p><a href="rel">x</a></main></body></html>`;
    expect(parseViaLinkedom(messy, 'https://jp.example.com/')).toEqual(
      parsePage(messy, 'https://jp.example.com/'),
    );
  });

  it('uppercase-attribute pre-scan: HTML4 <META NAME=...> routes to the main thread', () => {
    const html4 = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">
      <HTML LANG="fr"><HEAD><TITLE>Vieux</TITLE>
      <META NAME="description" CONTENT="page héritée">
      </HEAD><BODY><P>${'mot '.repeat(20)}</P></BODY></HTML>`;
    expect(needsMainThreadParse(html4)).toBe(true);
    // …and the divergence is real: linkedom misses the uppercase attributes
    // while the spec-conformant DOMParser extracts them.
    expect(parseViaLinkedom(html4, 'https://old.example.com/').description).toBe('');
    const viaDom = parsePage(html4, 'https://old.example.com/');
    expect(viaDom.description).toBe('page héritée');
    expect(viaDom.language).toBe('fr');
  });

  it('pre-scan leaves normal pages on the worker path', () => {
    expect(needsMainThreadParse(UNION_PAGE)).toBe(false);
    expect(needsMainThreadParse('<html><head><title>x</title></head><body></body></html>')).toBe(false);
  });

  it('pool falls back to INLINE processing where Worker is unavailable (vitest/jsdom)', async () => {
    expect(typeof Worker).toBe('undefined'); // the fallback precondition
    const pool = new WorkerPool(4);
    const result = await pool.processPage(UNION_PAGE, 'https://example.com/page');
    expect(result.parsed.title).toBe('Union Page');
    expect(result.parsed.links).toContain('https://example.com/next');
    expect(result.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    await pool.dispose();
  });

  it('enrich rides the same boundary: enrichment present only when requested', async () => {
    const enriched = await processInline(UNION_PAGE, 'https://example.com/page', true);
    expect(enriched.enrichment).toBeDefined();
    expect(enriched.enrichment!.topics.length).toBeGreaterThan(0);
    const plain = await processInline(UNION_PAGE, 'https://example.com/page', false);
    expect(plain.enrichment).toBeUndefined();
  });

  it('InlineProcessor satisfies the PageProcessor interface', async () => {
    const inline = new InlineProcessor();
    const result = await inline.processPage(UNION_PAGE, 'https://example.com/page', { enrich: true });
    expect(result.parsed.title).toBe('Union Page');
    expect(result.enrichment).toBeDefined();
    await inline.dispose();
  });
});
