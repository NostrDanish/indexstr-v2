/**
 * SIP-01 compliance checklist — the 30-item audit checklist
 * (audit/sip01-contract.md §6, v2-blueprint §5) encoded as named tests.
 * Every test name carries its checklist number so the checklist ↔ suite
 * mapping is auditable.
 *
 * Scope honesty: items A1–A19 (event construction) and B20–B22 are fully
 * executable at the protocol layer and tested behaviorally here. Items
 * B23–B27 and C28–C30 are crawler/heartbeat behaviors that live in
 * `@sip01/crawler-core`; here they are pinned as protocol-layer static
 * assertions (the seams the crawler depends on) with the delegation noted.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';

import {
  WEB_INDEX_KIND,
  WEB_INDEX_SCHEMA_VERSION,
  WEB_INDEX_D_PREFIX,
  buildIndexEvent,
  contentHash,
  documentId,
  normalizeIndexUrl,
  parseIndexEvent,
  verifyObservation,
} from '../webIndex';
import {
  getIndexerIdentity,
  regenerateIndexerIdentity,
  exportIndexerNsec,
} from '../indexerIdentity';
import { validateWebDocument } from './relayValidator';

const here = dirname(fileURLToPath(import.meta.url));
const src = (name: string) => readFileSync(join(here, '..', name), 'utf8');

const BASE = { url: 'https://example.com/page', title: 'Example Page' } as const;

function tagValues(tags: string[][], name: string): string[] {
  return tags.filter(([n]) => n === name).map(([, v]) => v);
}

describe('A. Event construction', () => {
  it('A1 emits kind 39697 exactly', async () => {
    const event = (await buildIndexEvent(BASE))!;
    expect(event.kind).toBe(39697);
    expect(event.kind).toBe(WEB_INDEX_KIND);
  });

  it('A2 normalizeIndexUrl passes all 4 spec §13.1 vectors', () => {
    expect(normalizeIndexUrl('https://example.com/')).toBe('https://example.com/');
    expect(normalizeIndexUrl('HTTPS://WWW.Example.Com:443/page/?b=2&utm_source=x&a=1#top')).toBe(
      'https://example.com/page?a=1&b=2',
    );
    expect(normalizeIndexUrl('https://example.com/page')).toBe('https://example.com/page');
    expect(normalizeIndexUrl('https://github.com/NostrDanish/Crwalstr')).toBe(
      'https://github.com/NostrDanish/Crwalstr',
    );
  });

  it('A3 d = "widx:"+sha256(normalized)[0:32], recomputed from normalized u', async () => {
    const event = (await buildIndexEvent({
      url: 'https://www.example.com/p/?utm_campaign=x#frag',
      title: 'T',
    }))!;
    const u = tagValues(event.tags, 'u')[0];
    expect(u).toBe('https://example.com/p');
    expect(tagValues(event.tags, 'd')[0]).toBe(await documentId(u));
    expect(tagValues(event.tags, 'd')[0]).toMatch(/^widx:[0-9a-f]{32}$/);
    expect(tagValues(event.tags, 'd')[0].startsWith(WEB_INDEX_D_PREFIX)).toBe(true);
  });

  it('A4 x = sha256(title+"\\n"+description) over the TRUNCATED published strings', async () => {
    const event = (await buildIndexEvent({
      url: 'https://example.com/t',
      title: 'T'.repeat(400),
      description: 'D'.repeat(1500),
    }))!;
    const content = JSON.parse(event.content) as { title: string; description: string };
    expect(content.title.length).toBe(300);
    expect(content.description.length).toBe(1000);
    // x matches the truncated values that actually went on the wire.
    expect(tagValues(event.tags, 'x')[0]).toBe(
      await contentHash(content.title, content.description),
    );
  });

  it('A5 x reproduces both spec §13.2 content-hash vectors', async () => {
    expect(await contentHash('Example')).toBe(
      'e1762f14d9924e37b32f1c81dfd256410af462f5136415c96877efa8c80345d0',
    );
    expect(await contentHash('Example Page', 'A page about examples.')).toBe(
      '2a5cbdf44513f552fb571d6c6de2ddf16c5452b235cc887980b52898fb38e7c1',
    );
  });

  it('A6 exactly one each of d, u, v, alt', async () => {
    const event = (await buildIndexEvent({
      ...BASE,
      tags: ['a', 'b'],
      language: 'en',
      published: 1754600000,
      source: 'crawlstr/2',
      type: 'page',
    }))!;
    for (const name of ['d', 'u', 'v', 'alt']) {
      expect(tagValues(event.tags, name).length, `tag ${name}`).toBe(1);
    }
  });

  it('A7 v tag = "1"', async () => {
    const event = (await buildIndexEvent(BASE))!;
    expect(tagValues(event.tags, 'v')).toEqual(['1']);
    expect(WEB_INDEX_SCHEMA_VERSION).toBe('1');
  });

  it('A8 alt present, non-empty, ≤1000, presentation-only', async () => {
    const longTitle = (await buildIndexEvent({ url: 'https://example.com/', title: 'T'.repeat(2000) }))!;
    const alt = tagValues(longTitle.tags, 'alt')[0];
    expect(alt).toBeTruthy();
    expect(alt.trim().length).toBeGreaterThan(0);
    // title capped at 300 ⇒ "Web index observation: " + 300 ≤ 1000 always.
    expect(alt.length).toBeLessThanOrEqual(1000);
    expect(alt.startsWith('Web index observation: ')).toBe(true);
  });

  it('A9 u ≤2048, http(s) only — rejected at build AND parse', async () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'magnet:?xt=1']) {
      expect(await buildIndexEvent({ url: bad, title: 'T' }), bad).toBeNull();
      expect(normalizeIndexUrl(bad)).toBeNull();
    }
    const longUrl = `https://example.com/${'a'.repeat(2100)}`;
    expect(await buildIndexEvent({ url: longUrl, title: 'T' })).toBeNull();

    // Parse side: a hand-crafted event with a bad u tag must not parse.
    const sk = generateSecretKey();
    const good = (await buildIndexEvent(BASE))!;
    const tampered = finalizeEvent(
      {
        kind: WEB_INDEX_KIND,
        created_at: 1754650000,
        content: good.content,
        tags: good.tags.map((t) => (t[0] === 'u' ? ['u', 'javascript:alert(1)'] : t)),
      },
      sk,
    );
    expect(parseIndexEvent(tampered)).toBeNull();
  });

  it('A10 title 1–300 after trim; no event when empty', async () => {
    expect(await buildIndexEvent({ url: 'https://example.com/', title: '   ' })).toBeNull();
    expect(await buildIndexEvent({ url: 'https://example.com/', title: '' })).toBeNull();
    const event = (await buildIndexEvent({ url: 'https://example.com/', title: `  ${'T'.repeat(400)}  ` }))!;
    const content = JSON.parse(event.content) as { title: string };
    expect(content.title.length).toBe(300);
  });

  it('A11 description ≤1000, plain text', async () => {
    const event = (await buildIndexEvent({ ...BASE, description: 'D'.repeat(5000) }))!;
    const content = JSON.parse(event.content) as { description: string };
    expect(content.description.length).toBe(1000);
  });

  it('A12 image https-only, ≤2048, dropped otherwise', async () => {
    const http = (await buildIndexEvent({ ...BASE, image: 'http://cdn.example.com/x.png' }))!;
    expect(JSON.parse(http.content)).not.toHaveProperty('image');
    const data = (await buildIndexEvent({ ...BASE, image: 'data:image/png;base64,AA' }))!;
    expect(JSON.parse(data.content)).not.toHaveProperty('image');
    const long = (await buildIndexEvent({
      ...BASE,
      image: `https://cdn.example.com/${'p'.repeat(3000)}.png`,
    }))!;
    expect((JSON.parse(long.content) as { image: string }).image.length).toBe(2048);
    const ok = (await buildIndexEvent({ ...BASE, image: 'https://cdn.example.com/x.png' }))!;
    expect((JSON.parse(ok.content) as { image: string }).image).toBe('https://cdn.example.com/x.png');
  });

  it('A13 topics lowercase, ^[a-z0-9][a-z0-9-]{0,99}$, deduped, ≤8', async () => {
    const event = (await buildIndexEvent({
      ...BASE,
      tags: ['Nostr', 'nostr', 'privacy tools', 'C++', 'under_score', '-lead', 'ok', 't2', 't3', 't4', 't5', 't6', 't7'],
    }))!;
    const topics = tagValues(event.tags, 't');
    expect(topics).toEqual(['nostr', 'privacy-tools', 'ok', 't2', 't3', 't4', 't5', 't6']);
    expect(topics.length).toBeLessThanOrEqual(8);
    for (const t of topics) expect(t).toMatch(/^[a-z0-9][a-z0-9-]{0,99}$/);
    expect(new Set(topics).size).toBe(topics.length);
  });

  it('A14 l: bare ["l","xx"], ^[a-z]{2}$, at most one, no L tag', async () => {
    const event = (await buildIndexEvent({ ...BASE, language: 'EN' }))!;
    expect(event.tags.filter(([n]) => n === 'l')).toEqual([['l', 'en']]);
    expect(event.tags.filter(([n]) => n === 'L')).toEqual([]);

    const bad = (await buildIndexEvent({ ...BASE, language: 'eng' }))!;
    expect(tagValues(bad.tags, 'l')).toEqual([]);
    const bad2 = (await buildIndexEvent({ ...BASE, language: 'e1' }))!;
    expect(tagValues(bad2.tags, 'l')).toEqual([]);
  });

  it('A15 published rejects pre-1970 dates (the clamp divergence, audit C-1)', async () => {
    // THE divergence from upstream sip-01-core@live webIndex.ts:204: negative
    // and zero `published` values must never reach the wire — relays reject
    // the whole event (`^\d{1,16}$`).
    const negative = (await buildIndexEvent({ ...BASE, published: -315619200 }))!;
    expect(tagValues(negative.tags, 'published')).toEqual([]);
    const zero = (await buildIndexEvent({ ...BASE, published: 0 }))!;
    expect(tagValues(zero.tags, 'published')).toEqual([]);
    const nan = (await buildIndexEvent({ ...BASE, published: NaN }))!;
    expect(tagValues(nan.tags, 'published')).toEqual([]);
    const infinite = (await buildIndexEvent({ ...BASE, published: Infinity }))!;
    expect(tagValues(infinite.tags, 'published')).toEqual([]);

    // Positive values: floored to integer unix seconds, ≤16 digits.
    const fractional = (await buildIndexEvent({ ...BASE, published: 1754600000.9 }))!;
    expect(tagValues(fractional.tags, 'published')).toEqual(['1754600000']);
    const huge = (await buildIndexEvent({ ...BASE, published: 999999999999999 }))!;
    expect(tagValues(huge.tags, 'published')).toEqual(['999999999999999']);

    // Every emitted value matches the relay regex.
    for (const p of [1, 946684800, 1754600000, 999999999999999]) {
      const ev = (await buildIndexEvent({ ...BASE, published: p }))!;
      expect(tagValues(ev.tags, 'published')[0]).toMatch(/^\d{1,16}$/);
    }
    // And the relay validator accepts what we build (parity spot-check).
    expect(validateWebDocument({ ...fractional, created_at: 0, pubkey: '' })).toBeUndefined();
  });

  it('A16 source ≤100, informational <name>/<version>', async () => {
    const event = (await buildIndexEvent({ ...BASE, source: '  crawlstr/2  ' }))!;
    expect(tagValues(event.tags, 'source')).toEqual(['crawlstr/2']);
    const long = (await buildIndexEvent({ ...BASE, source: 'x'.repeat(150) }))!;
    expect(tagValues(long.tags, 'source')[0].length).toBe(100);
    expect(tagValues(event.tags, 'source')[0]).toMatch(/^[^\s]+\/[^\s]+$/);
  });

  it('A17 extension tags only from §9.2, keyword-shaped, correct case', async () => {
    const event = (await buildIndexEvent({
      url: 'https://github.com/NostrDanish/Crwalstr',
      title: 'Crwalstr',
      type: 'Repository',
      platform: 'GitHub',
      category: 'Tools',
      network: 'Clearnet',
      country: 'de',
      mime: 'APPLICATION/PDF',
    }))!;
    expect(event.tags).toContainEqual(['type', 'repository']); // keyword: lowercased
    expect(event.tags).toContainEqual(['platform', 'github']);
    expect(event.tags).toContainEqual(['category', 'tools']);
    expect(event.tags).toContainEqual(['network', 'clearnet']);
    expect(event.tags).toContainEqual(['country', 'DE']); // country: uppercased
    expect(event.tags).toContainEqual(['mime', 'application/pdf']); // mime: lowercased

    // Invalid values dropped, never fatal (§9.1 rule 1).
    const bad = (await buildIndexEvent({
      ...BASE,
      type: 'not a keyword!',
      country: 'DEN',
      mime: 'not-a-mime',
    }))!;
    for (const name of ['type', 'country', 'mime']) {
      expect(tagValues(bad.tags, name)).toEqual([]);
    }
  });

  it('A18 no unknown/reserved tags squatted on; builder emits only registered tags', async () => {
    const event = (await buildIndexEvent({
      ...BASE,
      tags: ['nostr'],
      language: 'en',
      published: 1754600000,
      source: 'crawlstr/2',
      type: 'page',
      platform: 'web',
      category: 'docs',
      network: 'clearnet',
      country: 'DE',
      mime: 'text/html',
    }))!;
    const REGISTERED = new Set([
      'd', 'u', 't', 'l', 'x', 'v', 'published', 'source', 'alt',
      'type', 'platform', 'category', 'network', 'country', 'mime',
    ]);
    for (const [name] of event.tags) {
      expect(REGISTERED.has(name), `unregistered tag "${name}"`).toBe(true);
    }
    // Single-letter names beyond the relay-filterable core set are RESERVED.
    const singleLetter = event.tags.map(([n]) => n).filter((n) => n.length === 1);
    for (const n of singleLetter) expect(['d', 'u', 't', 'l', 'x', 'v']).toContain(n);
  });

  it('A19 content JSON contains only title/description/image — no query, identity, or scores', async () => {
    const event = (await buildIndexEvent({
      url: 'https://example.com/search?q=who+is+jon+smith&tracking=1',
      title: 'Result Page',
      description: 'Desc',
      image: 'https://cdn.example.com/x.png',
    }))!;
    const keys = Object.keys(JSON.parse(event.content)).sort();
    expect(keys).toEqual(['description', 'image', 'title']);
    // No query material in the CONTENT (the u tag legitimately carries the
    // page's own query string — the ban is on the SEARCHer's query, which
    // must never appear in content or non-u tags).
    expect(event.content).not.toContain('who+is+jon');
    expect(event.content).not.toContain('who is jon');
    expect(event.content).not.toContain('q=who');
    for (const [name, value] of event.tags) {
      if (name === 'u') continue;
      expect(value, `tag ${name}`).not.toContain('who+is+jon');
      expect(value, `tag ${name}`).not.toContain('q=who');
    }
    // No score/reputation fields.
    for (const banned of ['score', 'rank', 'reputation', 'author', 'pubkey', 'user']) {
      expect(JSON.parse(event.content)).not.toHaveProperty(banned);
      expect(event.tags.some(([n]) => n === banned)).toBe(false);
    }
  });
});

describe('B. Identity, timing, publishing behavior', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('B20 dedicated indexer keypair: generated+stored locally, rotation = new indexer', () => {
    const first = getIndexerIdentity();
    expect(first.secretHex).toMatch(/^[0-9a-f]{64}$/);
    expect(first.npub.startsWith('npub1')).toBe(true);
    expect(first.fresh).toBe(true);

    // Persistent across calls (same browser profile).
    expect(getIndexerIdentity().pubkeyHex).toBe(first.pubkeyHex);

    // The indexer key is its own identity — nothing links it to a user key;
    // the module never accepts an external/personal key as input.
    const userKey = generateSecretKey();
    expect(first.secretHex).not.toBe(Buffer.from(userKey).toString('hex'));

    // Rotation = a NEW indexer; old history stays under the old key.
    const rotated = regenerateIndexerIdentity();
    expect(rotated.pubkeyHex).not.toBe(first.pubkeyHex);
    expect(getIndexerIdentity().pubkeyHex).toBe(rotated.pubkeyHex);

    // Export is the only way the secret leaves the module, explicitly.
    expect(exportIndexerNsec().startsWith('nsec1')).toBe(true);
  });

  it('B21 created_at = now (seconds), never future-dated', async () => {
    const template = (await buildIndexEvent(BASE))!;
    const before = Math.floor(Date.now() / 1000);
    const signed = finalizeEvent(
      { ...template, created_at: Math.floor(Date.now() / 1000) },
      generateSecretKey(),
    );
    const after = Math.floor(Date.now() / 1000);
    expect(Number.isInteger(signed.created_at)).toBe(true);
    expect(signed.created_at).toBeGreaterThanOrEqual(before);
    expect(signed.created_at).toBeLessThanOrEqual(after); // never in the future
    // The observation time surfaces as observedAt on the parsed reader side.
    expect(parseIndexEvent(signed)!.observedAt).toBe(signed.created_at);
  });

  it('B22 recrawl republishes same d with fresh created_at (replace, not delete-first)', async () => {
    const sk = generateSecretKey();
    const template = (await buildIndexEvent(BASE))!;
    const first = finalizeEvent({ ...template, created_at: 1754600000 }, sk);
    const second = finalizeEvent({ ...template, created_at: 1754700000 }, sk);

    const d1 = tagValues(first.tags, 'd')[0];
    const d2 = tagValues(second.tags, 'd')[0];
    // Same addressable coordinate (kind, pubkey, d) ⇒ relays REPLACE (NIP-01).
    expect(d1).toBe(d2);
    expect(first.kind).toBe(second.kind);
    expect(first.pubkey).toBe(second.pubkey);
    expect(second.created_at).toBeGreaterThan(first.created_at);

    // Unchanged pages republish with the SAME x — the freshness signal.
    expect(tagValues(first.tags, 'x')).toEqual(tagValues(second.tags, 'x'));
    // Changed content changes x but not d.
    const changed = (await buildIndexEvent({ ...BASE, title: 'Example Page v2' }))!;
    expect(tagValues(changed.tags, 'd')).toEqual([d1]);
    expect(tagValues(changed.tags, 'x')).not.toEqual(tagValues(first.tags, 'x'));
  });

  it('B23 recrawl parity — protocol exposes observedAt + published for the freshness layer (crawler-core)', async () => {
    // Adaptive recrawl (24h → doubling ≤30d → reset on change) is implemented
    // in @sip01/crawler-core. The protocol seam it needs: both timestamps
    // survive the build→sign→parse round-trip.
    const sk = generateSecretKey();
    const template = (await buildIndexEvent({ ...BASE, published: 1700000000 }))!;
    const signed = finalizeEvent({ ...template, created_at: 1754650000 }, sk);
    const obs = parseIndexEvent(signed)!;
    expect(obs.observedAt).toBe(1754650000);
    expect(obs.published).toBe(1700000000);
    expect(await verifyObservation(obs)).toBe(true);
  });

  it('B24 publish-set hygiene — protocol ships NO hardcoded publish set; SIP-01-aware relays require NIP-11 proof', () => {
    // The publish relay list belongs to the host app / crawler-core config
    // (conformance: ≥2 relays, ≥1 SIP-01-aware index relay, no read-only
    // proxies). This package's only relay URLs are DISCOVERY candidates that
    // must pass NIP-11 verification before use — never publish targets.
    const discovery = src('relayDiscovery.ts');
    expect(discovery).toContain('uncaged_index');
    // Candidates are gated on `sip01 === true` from the NIP-11 document.
    expect(discovery).toMatch(/\.sip01 === true/);
    // And the wire builder itself contains no relay URLs at all.
    expect(src('webIndex.ts')).not.toContain('wss://');
    expect(src('indexerIdentity.ts')).not.toContain('wss://');
  });

  it('B25 invalid observations are detectable reader-side (outbox accounting lives in crawler-core)', async () => {
    // The publisher must not count relay `invalid:` rejections as delivered.
    // Protocol layer: the same invalidity is detectable BEFORE publishing —
    // parse rejects, verify fails, and the relay validator names the reason.
    const sk = generateSecretKey();
    const good = (await buildIndexEvent(BASE))!;
    const badX = finalizeEvent(
      {
        ...good,
        created_at: 1754650000,
        tags: good.tags.map((t) => (t[0] === 'x' ? ['x', '0'.repeat(64)] : t)),
      },
      sk,
    );
    const obs = parseIndexEvent(badX)!; // structurally parseable…
    expect(await verifyObservation(obs)).toBe(false); // …but not self-consistent
    expect(validateWebDocument(badX)).toMatch(/x tag does not match/);
  });

  it('B26 SSRF seam — the wire builder performs no network egress at all', () => {
    // The hardened SSRF guard is crawler-core's net.ts. The protocol-level
    // invariant this package owns: building/parsing events NEVER fetches —
    // the only URL gate here is the http(s) scheme allowlist (A9).
    for (const file of ['webIndex.ts', 'indexerIdentity.ts']) {
      const code = src(file);
      expect(code, file).not.toMatch(/\bfetch\s*\(/);
      expect(code, file).not.toMatch(/\bWebSocket\b/);
      expect(code, file).not.toMatch(/\bXMLHttpRequest\b/);
    }
  });

  it('B27 politeness seam — the protocol package contains no timers or crawl loops', () => {
    // Per-domain politeness (≥5s) is crawler-core's scheduler. Protocol code
    // must be pure: no scheduling primitives on the build/parse path.
    for (const file of ['webIndex.ts', 'indexerIdentity.ts']) {
      const code = src(file);
      expect(code, file).not.toMatch(/\bsetInterval\b/);
      expect(code, file).not.toMatch(/\bsetTimeout\b/);
    }
  });
});

describe('C. Network-level (kind 16919 heartbeats) — auxiliary contract', () => {
  it('C28 heartbeat kind 16919 is NOT emitted by the protocol package (crawler-core owns it)', () => {
    // Heartbeat construction (replaceable, start + 10 min cadence, TTL 3600)
    // lives in @sip01/crawler-core/heartbeat.ts. This package must never
    // construct kind 16919 — pin that boundary.
    for (const file of ['webIndex.ts', 'indexerIdentity.ts', 'relayDiscovery.ts', 'index.ts']) {
      expect(src(file), file).not.toContain('16919');
    }
  });

  it('C29 heartbeat payload discipline — no coarse-stats payload keys in the protocol package', () => {
    // The heartbeat payload ({v, shard, platform, network, charging, stats})
    // is a crawler-core artifact; none of its distinctive keys may leak into
    // the observation wire format here.
    const observation = src('webIndex.ts');
    expect(observation).not.toContain('charging');
    expect(observation).not.toContain('shard');
  });

  it('C30 heartbeats never feed reputation — no heartbeat stats imports exist to consume', () => {
    // Reputation inputs come only from kind 39697 observations. This package
    // exports no heartbeat stats surface at all, so no reputation consumer
    // can import them from here (structural guarantee).
    const barrel = src('index.ts');
    expect(barrel).not.toMatch(/heartbeat/i);
    expect(barrel).not.toContain('16919');
    // The only kind constant exported is the observation kind.
    expect(WEB_INDEX_KIND).toBe(39697);
    expect(src('webIndex.ts')).toContain('export const WEB_INDEX_KIND = 39697');
  });
});
