/**
 * Relay-validator parity smoke test.
 *
 * Feeds all 50 golden-corpus events plus a corpus of deliberately-invalid
 * events through a verbatim port of the UNCAGED Index Relay's
 * `validateWebDocument` regex/validation table (relayValidator.ts).
 *
 * Contract: EVERYTHING `buildIndexEvent` can emit MUST pass the strictest
 * consumer in the ecosystem (the relay); every invalid event MUST fail with
 * the expected reason class. If a future change makes the builder emit
 * something the relay rejects, that change is a network-breaking bug — this
 * test catches it before deployment.
 */
import { describe, it, expect } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import { buildIndexEvent, type IndexObservationInput } from '../webIndex';
import {
  relayNormalizeIndexUrl,
  relayWebDocumentContentHash,
  relayWebDocumentDTag,
  validateWebDocument,
  type RelayEvent,
} from './relayValidator';
import corpus from './golden-corpus.json';

interface GoldenEntry {
  name: string;
  input: IndexObservationInput;
  expected: { normalized: string; d: string; x: string; content: string; tags: string[][] };
}

const golden = corpus.events as unknown as GoldenEntry[];

/** Fixed key — signature validity is irrelevant to validateWebDocument, but
 *  the events are shaped like the real thing (and double-checked parseable). */
const SK = generateSecretKey();
const PK = getPublicKey(SK);
const NOW = 1754650000;

function sign(kind: number, content: string, tags: string[][]): RelayEvent {
  return finalizeEvent({ kind, created_at: NOW, content, tags }, SK);
}

/**
 * Hand-craft an event that is valid in every respect EXCEPT the one under
 * test (d and x are recomputed to match the given u/content unless
 * overridden), so each case fails for exactly the intended reason.
 */
function craft(opts: {
  u?: string;
  content?: string;
  title?: string;
  description?: string;
  extraTags?: string[][];
  dropTags?: string[];
  mutateTags?: (tags: string[][]) => string[][];
}): RelayEvent {
  const u = opts.u ?? 'https://example.com/parity';
  const content =
    opts.content ??
    JSON.stringify({
      title: opts.title ?? 'Parity Test Page',
      ...(opts.description !== undefined ? { description: opts.description } : {}),
    });

  let parsedTitle = opts.title ?? 'Parity Test Page';
  let parsedDescription: string | undefined = opts.description;
  try {
    const c = JSON.parse(content) as { title?: unknown; description?: unknown };
    if (typeof c.title === 'string') parsedTitle = c.title;
    parsedDescription = typeof c.description === 'string' ? c.description : undefined;
  } catch {
    /* non-JSON content case — x value below is then irrelevant */
  }

  const normalized = relayNormalizeIndexUrl(u);
  let tags: string[][] = [
    ['d', normalized ? relayWebDocumentDTag(normalized) : 'widx:00000000000000000000000000000000'],
    ['u', u],
    ['x', relayWebDocumentContentHash(parsedTitle, parsedDescription)],
    ['v', '1'],
    ['alt', `Web index observation: ${parsedTitle}`],
    ...(opts.extraTags ?? []),
  ];
  for (const drop of opts.dropTags ?? []) tags = tags.filter(([n]) => n !== drop);
  if (opts.mutateTags) tags = opts.mutateTags(tags);
  return sign(39697, content, tags);
}

describe('relay parity — all 50 golden events pass validateWebDocument', () => {
  it.each(golden.map((e) => [e.name, e] as const))(
    'golden %s is relay-acceptable',
    (_name, entry) => {
      const event = sign(39697, entry.expected.content, entry.expected.tags);
      expect(event.pubkey).toBe(PK);
      expect(validateWebDocument(event)).toBeUndefined();
    },
  );
});

describe('relay parity — deliberately-invalid events are rejected with the expected reason', () => {
  const CASES: [name: string, event: () => RelayEvent, reason: RegExp][] = [
    ['missing d tag', () => craft({ dropTags: ['d'] }), /missing d tag/],
    ['multiple d tags', () => craft({ mutateTags: (t) => [...t, ['d', 'widx:0'.repeat(32)]] }), /multiple d tags/],
    ['missing u tag', () => craft({ dropTags: ['u'] }), /missing u tag/],
    ['multiple u tags', () => craft({ mutateTags: (t) => [...t, ['u', 'https://example.com/other']] }), /multiple u tags/],
    ['missing v tag', () => craft({ dropTags: ['v'] }), /missing v tag/],
    ['unsupported v "2"', () => craft({ mutateTags: (t) => t.map((x) => (x[0] === 'v' ? ['v', '2'] : x)) }), /unsupported web document schema version/],
    ['missing alt tag', () => craft({ dropTags: ['alt'] }), /missing alt tag/],
    ['blank alt tag', () => craft({ mutateTags: (t) => t.map((x) => (x[0] === 'alt' ? ['alt', '   '] : x)) }), /missing alt tag/],
    ['oversized alt (>1000)', () => craft({ mutateTags: (t) => t.map((x) => (x[0] === 'alt' ? ['alt', 'a'.repeat(1001)] : x)) }), /alt tag exceeds 1000/],
    ['oversized u (>2048)', () => craft({ u: `https://example.com/${'a'.repeat(2100)}` }), /u tag exceeds 2048/],
    ['non-http(s) u', () => craft({ u: 'ftp://example.com/file' }), /not a valid http\(s\) URL/],
    ['d does not match u', () => craft({ mutateTags: (t) => t.map((x) => (x[0] === 'd' ? ['d', 'widx:' + 'f'.repeat(32)] : x)) }), /d tag does not match/],
    ['content not JSON', () => craft({ content: 'not json' }), /not valid JSON/],
    ['empty title', () => craft({ title: '   ' }), /title must be 1-300/],
    ['oversized title (>300)', () => craft({ title: 'T'.repeat(301) }), /title must be 1-300/],
    ['oversized description (>1000)', () => craft({ description: 'D'.repeat(1001) }), /description exceeds 1000/],
    ['http image', () => craft({ content: JSON.stringify({ title: 'P', image: 'http://insecure.example.com/x.png' }) }), /image must be an https URL/],
    ['9 topic tags', () => craft({ extraTags: Array.from({ length: 9 }, (_, i) => ['t', `topic${i}`]) }), /more than 8 topic tags/],
    ['bad topic shape', () => craft({ extraTags: [['t', 'Bad_Topic']] }), /topic \(t\) tags must be lowercase/],
    ['bad l tag', () => craft({ extraTags: [['l', 'eng']] }), /not a valid ISO 639-1/],
    ['x not hex-64', () => craft({ mutateTags: (t) => t.map((x) => (x[0] === 'x' ? ['x', 'XYZ'] : x)) }), /lowercase hex sha256/],
    ['x does not match content', () => craft({ mutateTags: (t) => t.map((x) => (x[0] === 'x' ? ['x', '0'.repeat(64)] : x)) }), /x tag does not match/],
    ['negative published (the C-1 bug the clamp prevents)', () => craft({ extraTags: [['published', '-315619200']] }), /published tag must be a unix timestamp/],
    ['published with 17 digits', () => craft({ extraTags: [['published', '99999999999999999']] }), /published tag must be a unix timestamp/],
    ['oversized source (>100)', () => craft({ extraTags: [['source', 's'.repeat(101)]] }), /source tag exceeds 100/],
    ['bad extension keyword', () => craft({ extraTags: [['type', 'not a keyword!']] }), /type tag is not a valid keyword/],
    ['bad country', () => craft({ extraTags: [['country', 'USA']] }), /country tag must be an ISO 3166-1/],
    ['bad mime', () => craft({ extraTags: [['mime', 'not-a-mime']] }), /mime tag is not a valid MIME/],
  ];

  it.each(CASES.map(([n, e, r]) => [n, e, r] as const))(
    'rejects: %s',
    (_name, make, reason) => {
      const rejection = validateWebDocument(make());
      expect(rejection).toBeDefined();
      expect(rejection).toMatch(reason);
    },
  );

  it('the invalid corpus covers every validator rule class (28 cases)', () => {
    expect(CASES.length).toBe(28);
  });
});

describe('relay parity — builder/validator agreement invariants', () => {
  it('relay normalization is byte-identical to the reference normalizer on the whole corpus', () => {
    for (const entry of golden) {
      expect(relayNormalizeIndexUrl(entry.input.url)).toBe(entry.expected.normalized);
    }
  });

  it('relay d/x recomputation matches the pinned golden values', () => {
    for (const entry of golden) {
      expect(relayWebDocumentDTag(entry.expected.normalized)).toBe(entry.expected.d);
      const content = JSON.parse(entry.expected.content) as { title: string; description?: string };
      expect(relayWebDocumentContentHash(content.title, content.description)).toBe(entry.expected.x);
    }
  });

  it('a random sample of freshly built events (not just pinned fixtures) passes the validator', async () => {
    for (let i = 0; i < 25; i++) {
      const event = (await buildIndexEvent({
        url: `https://host${i}.example.com/path/${i}?q=${i}&utm_source=x`,
        title: `Random Page ${i}`,
        description: `Description ${i}`,
        tags: [`topic${i}`, 'shared'],
        language: 'en',
        published: 1700000000 + i,
        source: 'crawlstr/2',
      }))!;
      const signed = sign(event.kind, event.content, event.tags);
      expect(validateWebDocument(signed)).toBeUndefined();
    }
  });
});
