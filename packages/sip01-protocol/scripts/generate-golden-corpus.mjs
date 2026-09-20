/**
 * Golden-corpus generator — builds 50 diverse SIP-01 observation events with
 * the CURRENT src/webIndex.ts implementation (via `dist/`, run `npm run
 * build` first) and pins the byte-exact wire output into
 * `src/conformance/golden-corpus.json`.
 *
 * Regenerate ONLY intentionally (a wire-format change is a network fork —
 * any diff in this fixture must be reviewed as such):
 *
 *   npm run build && node scripts/generate-golden-corpus.mjs
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildIndexEvent, normalizeIndexUrl, documentId, contentHash } from '../dist/webIndex.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 50 diverse inputs: tracking params, unicode (paths, query values, titles),
 * non-default ports, www/case/fragment/trailing-slash variants, duplicate
 * query keys, topics incl. caps/dedup/shape-filtering, languages, published
 * (valid/zero/negative/fractional/absent — the zero/negative cases pin the
 * clamp divergence), sources, all six extension tags (valid + dropped
 * invalids), https/http/relative images, and truncation-boundary lengths.
 */
const INPUTS = [
  // --- 1–10: URL normalization diversity ---
  { url: 'https://example.com/', title: 'Example Domain' },
  { url: 'HTTPS://WWW.Example.Com:443/page/?b=2&utm_source=x&a=1#top', title: 'Spec Vector Page', description: 'Tracks utm_source stripping.' },
  { url: 'https://github.com/NostrDanish/Crwalstr', title: 'Crwalstr Repository', tags: ['nostr', 'crawler'], platform: 'github', type: 'repository' },
  { url: 'http://example.org:80/path/to/page/', title: 'Plain HTTP With Default Port', source: 'crawlstr/v2' },
  { url: 'https://example.net:8443/secure/page?x=1#frag', title: 'Non-Default Port', language: 'en', published: 1754600000 },
  { url: 'https://example.com/search?q=nostr+protocol&utm_medium=email&gclid=AbC123&page=2', title: 'Search Results', tags: ['search'] },
  { url: 'https://m.facebook.com/story.php?story_fbid=1&id=2&fbclid=IwAR123&mc_cid=abc&mc_eid=def', title: 'Social Story' },
  { url: 'https://youtu.be/watch?v=dQw4w9WgXcQ&si=tracking&t=42s', title: 'Video With si Param', platform: 'youtube', type: 'video' },
  { url: 'https://example.com/dup?k=1&k=2&k=3&a=z', title: 'Duplicate Query Keys', description: 'Stable sort keeps duplicate-key order.' },
  { url: 'https://example.com/empty?a=&b=2&utm_campaign=', title: 'Empty Query Values' },
  // --- 11–17: unicode / encoding ---
  { url: 'https://example.com/ümlaut/über', title: 'Ünïcodé Tïtlé', description: 'Beschreibung mit Umlauten.', language: 'de' },
  { url: 'https://ja.example.jp/記事/検索?クエリ=値&utm_term=x', title: '日本語のページ', description: '日本語の説明文。', language: 'ja', country: 'jp' },
  { url: 'https://example.com/emoji/🚀/launch', title: 'Emoji Path 🚀', tags: ['emoji'] },
  { url: 'https://zh.example.cn:8080/页面?关键词=测试&spm=a2e4d', title: '中文标题', language: 'zh', published: 1699999999 },
  { url: 'https://xn--nxasmq6b.example.gr/greek', title: 'Punycode Host' },
  { url: 'https://example.com/café?menu=crème+brûlée', title: 'Café Menu', language: 'fr', country: 'FR' },
  { url: 'https://example.com/a%2Fb/c%20d', title: 'Pre-Encoded Path Segments' },
  // --- 18–25: topics / language / published edges ---
  { url: 'https://blog.example.com/posts/1', title: 'Many Topics', tags: ['One', 'TWO', 'three-tag', 'one', ' four ', 'C++', 'under_score', '-bad', 'ok5', 't6', 't7', 't8', 't9', 't10'] },
  { url: 'https://blog.example.com/posts/2', title: 'Whitespace Topics', tags: ['privacy tools', 'web  search', 'nostr'] },
  { url: 'https://blog.example.com/posts/3', title: 'Invalid Language Dropped', language: 'eng' },
  { url: 'https://blog.example.com/posts/4', title: 'Uppercase Language Normalized', language: 'EN', published: 1 },
  { url: 'https://blog.example.com/posts/5', title: 'Fractional Published Floored', published: 1754600000.9 },
  { url: 'https://blog.example.com/posts/6', title: 'Zero Published Dropped (clamp)', published: 0 },
  { url: 'https://blog.example.com/posts/7', title: 'Negative Published Dropped (clamp)', published: -315619200, description: 'Page claims 1960 — pre-1970 dates must never reach the wire.' },
  { url: 'https://blog.example.com/posts/8', title: 'Huge Published Kept', published: 999999999999999 },
  // --- 26–33: extension tags ---
  { url: 'https://gitlab.com/group/project', title: 'GitLab Project', type: 'Repository', platform: 'GitLab', network: 'clearnet', country: 'de', mime: 'APPLICATION/PDF' },
  { url: 'https://docs.example.com/spec.pdf', title: 'PDF Spec', mime: 'application/pdf; charset=utf-8', type: 'file' },
  { url: 'https://onion.example.onion/hidden', title: 'Onion Service Doc', network: 'tor' },
  { url: 'https://example.com/bad-ext', title: 'Invalid Extensions Dropped', type: 'not a keyword!', country: 'DEN', mime: 'not-a-mime', platform: 'ok_platform-1' },
  { url: 'https://video.example.com/watch/9', title: 'Video Doc', type: 'video', platform: 'vimeo', category: 'Entertainment', network: 'clearnet' },
  { url: 'https://example.com/ext-underscore', title: 'Underscore Extension Value', type: 'doc_page' },
  { url: 'https://example.com/ext-max-len', title: 'Max Length Extension', category: 'a'.repeat(50) },
  { url: 'https://example.com/ext-too-long', title: 'Too Long Extension Dropped', category: 'b'.repeat(51) },
  // --- 34–40: images ---
  { url: 'https://example.com/img-ok', title: 'HTTPS Image', image: 'https://cdn.example.com/img/hero.png' },
  { url: 'https://example.com/img-http', title: 'HTTP Image Dropped', image: 'http://cdn.example.com/insecure.png' },
  { url: 'https://example.com/img-relative', title: 'Relative Image Dropped', image: '/images/hero.png' },
  { url: 'https://example.com/img-data', title: 'Data URI Image Dropped', image: 'data:image/png;base64,iVBORw0KGgo=' },
  { url: 'https://example.com/img-long', title: 'Long Image URL Sliced', image: `https://cdn.example.com/${'p'.repeat(3000)}.png` },
  { url: 'https://example.com/img-case', title: 'HTTPS Uppercase Scheme Image', image: 'HTTPS://CDN.Example.COM/Img.PNG' },
  { url: 'https://example.com/img-none', title: 'No Image At All', description: 'Image key must be absent from content.' },
  // --- 41–47: content truncation / structure ---
  { url: 'https://example.com/long-title', title: 'T'.repeat(400), description: 'Title truncates to 300.' },
  { url: 'https://example.com/long-desc', title: 'Long Description', description: 'D'.repeat(1500) },
  { url: 'https://example.com/whitespace-title', title: '   Padded Title   ', description: '  Padded description.  ' },
  { url: 'https://example.com/no-desc', title: 'No Description Key' },
  { url: 'https://example.com/empty-desc', title: 'Empty Description', description: '' },
  { url: 'https://example.com/long-source', title: 'Source Sliced To 100', source: 'crawlstr/v2 '.repeat(20) },
  { url: 'https://example.com/newlines', title: 'Title', description: 'Line one.\nLine two.\tTabbed.' },
  // --- 48–50: more URL corner cases ---
  { url: 'https://example.org:443/', title: 'Explicit Default HTTPS Port' },
  { url: 'http://www.example.com:8080/api/v1/items/?q=1&ref_src=twsrc', title: 'API Endpoint With ref_src', source: 'indexstr/v2' },
  { url: '  https://example.com/needs-trim  ', title: 'Padded URL Input', tags: ['trim'] },
];

if (INPUTS.length !== 50) {
  throw new Error(`expected 50 inputs, got ${INPUTS.length}`);
}

const entries = [];
for (const [i, input] of INPUTS.entries()) {
  const event = await buildIndexEvent(input);
  if (!event) throw new Error(`input #${i + 1} did not build: ${input.url}`);
  const normalized = normalizeIndexUrl(input.url);
  const content = JSON.parse(event.content);
  entries.push({
    name: `#${String(i + 1).padStart(2, '0')} ${input.title.slice(0, 60)}`,
    input,
    expected: {
      normalized,
      d: event.tags.find(([n]) => n === 'd')[1],
      x: event.tags.find(([n]) => n === 'x')[1],
      content: event.content,
      tags: event.tags,
      contentHashRecomputed: await contentHash(content.title, content.description ?? ''),
      documentIdRecomputed: await documentId(normalized),
    },
  });
}

const fixture = {
  $comment:
    'SIP-01 golden corpus v1 — 50 events. Byte-exact wire output of @sip01/protocol buildIndexEvent. ' +
    'Regenerate ONLY with an intentional wire-format change: npm run build && node scripts/generate-golden-corpus.mjs. ' +
    'A diff here without a spec revision = a network fork.',
  generatedBy: '@sip01/protocol scripts/generate-golden-corpus.mjs',
  schemaVersion: '1',
  events: entries,
};

const out = join(here, '..', 'src', 'conformance', 'golden-corpus.json');
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log(`wrote ${entries.length} golden events to ${out}`);
