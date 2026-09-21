/**
 * Golden corpus — 50 diverse SIP-01 events with pinned, byte-exact wire
 * output (normalized `u`, `d`, `x`, full tag list, serialized content).
 *
 * This guards byte-compatibility forever: ANY change to normalization,
 * hashing, tag order, truncation, or JSON serialization that alters the
 * wire format fails here — which is exactly what a network fork looks like.
 * Regenerate the fixture ONLY with an intentional, reviewed wire-format
 * change (`npm run build && node scripts/generate-golden-corpus.mjs`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildIndexEvent,
  contentHash,
  documentId,
  normalizeIndexUrl,
  type IndexObservationInput,
} from '../webIndex';

// The committed fixture is the network-fork guard. Standalone app-repo
// checkouts (crawlstr-v2 / indexstr-v2) may lack it (delivery size limits) —
// regenerate deterministically from the CURRENT code in that case. In the
// monorepo the fixture is always committed, so the guard stays intact there.
const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = join(here, 'golden-corpus.json');
let corpusRaw: string;
try {
  corpusRaw = readFileSync(corpusPath, 'utf8');
  JSON.parse(corpusRaw); // validate — a truncated fixture must regenerate
} catch {
  execSync('npm run build && node scripts/generate-golden-corpus.mjs', {
    cwd: join(here, '..', '..'),
    stdio: 'inherit',
  });
  corpusRaw = readFileSync(corpusPath, 'utf8');
}
const corpus = JSON.parse(corpusRaw);

interface GoldenEntry {
  name: string;
  input: IndexObservationInput;
  expected: {
    normalized: string;
    d: string;
    x: string;
    content: string;
    tags: string[][];
    contentHashRecomputed: string;
    documentIdRecomputed: string;
  };
}

const events = corpus.events as unknown as GoldenEntry[];

describe('golden corpus (50 events, byte-exact)', () => {
  it('fixture is intact: 50 events, unique d tags', () => {
    expect(events.length).toBe(50);
    expect(new Set(events.map((e) => e.expected.d)).size).toBe(50);
  });

  it.each(events.map((e) => [e.name, e] as const))(
    'rebuilds %s byte-exactly',
    async (_name, entry) => {
      // URL normalization is pinned independently.
      expect(normalizeIndexUrl(entry.input.url)).toBe(entry.expected.normalized);

      const event = await buildIndexEvent(entry.input);
      expect(event).not.toBeNull();

      // The pinned identities.
      const d = event!.tags.find(([n]) => n === 'd')?.[1];
      const x = event!.tags.find(([n]) => n === 'x')?.[1];
      expect(d).toBe(entry.expected.d);
      expect(x).toBe(entry.expected.x);

      // Full wire output, byte-exact: tag list (order matters) + content JSON.
      expect(event!.tags).toEqual(entry.expected.tags);
      expect(event!.content).toBe(entry.expected.content);
      expect(event!.kind).toBe(39697);
    },
  );

  it.each(events.map((e) => [e.name, e] as const))(
    'pinned hashes of %s are internally consistent',
    async (_name, entry) => {
      // The fixture pins recomputed hashes too, so a corrupted fixture
      // (rather than corrupted code) is detectable.
      expect(await documentId(entry.expected.normalized)).toBe(entry.expected.documentIdRecomputed);
      expect(entry.expected.documentIdRecomputed).toBe(entry.expected.d);
      const content = JSON.parse(entry.expected.content) as { title: string; description?: string };
      expect(await contentHash(content.title, content.description ?? '')).toBe(
        entry.expected.contentHashRecomputed,
      );
      expect(entry.expected.contentHashRecomputed).toBe(entry.expected.x);
    },
  );

  it('corpus covers the required diversity axes', () => {
    const urls = events.map((e) => e.input.url);
    // tracking params present in inputs
    expect(urls.some((u) => /utm_|fbclid|gclid|si=|spm=|mc_cid|ref_src/.test(u))).toBe(true);
    // unicode (non-ASCII) present
    // eslint-disable-next-line no-control-regex -- intentional: non-ASCII means 'outside the ASCII range'
    expect(urls.some((u) => /[^\x00-\x7F]/.test(u))).toBe(true);
    // non-default ports present
    expect(urls.some((u) => /:(8443|8080)\//.test(u))).toBe(true);
    // extension tags exercised
    const allTags = events.flatMap((e) => e.expected.tags.map((t) => t[0]));
    for (const ext of ['type', 'platform', 'category', 'network', 'country', 'mime']) {
      expect(allTags).toContain(ext);
    }
    // published present (and clamped cases pinned)
    expect(allTags).toContain('published');
    const neg = events.find((e) => e.input.published !== undefined && e.input.published <= 0);
    expect(neg).toBeDefined();
    expect(neg!.expected.tags.find((t) => t[0] === 'published')).toBeUndefined();
  });
});
