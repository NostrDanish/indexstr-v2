/**
 * Enrichment layer — turns a raw parsed page into structured, SIP-01-native
 * indexing metadata. This is the Indexstr division of labor:
 *
 *   Crawlstr says "I found this."
 *   Indexstr says "I verified, classified and enriched this."
 *
 * Design rules:
 *
 *   - DETERMINISTIC AND LOCAL. No AI, no network calls, no external service.
 *     Two Indexstr nodes classifying the same page produce the same tags —
 *     reproducibility IS the provenance story: agreement between independent
 *     indexers is verifiable by anyone.
 *   - SIP-01 COMPACT. Only the conclusions go on the wire: topics ride the
 *     existing `t` tags (spec §6), the document type rides the `type`
 *     extension tag (spec §9.2). No evidence payloads, no confidence
 *     decimals — the event stays small and byte-compatible with the whole
 *     ecosystem.
 *   - CONSERVATIVE. A tag is emitted only when the evidence is strong
 *     (title/keywords-level, not a stray body mention). Unsure = no tag.
 *
 * Evidence weights: meta keywords ×3 and title ×3 (the site's own summary),
 * headings ×2, description ×2, URL path ×1. Threshold 3 — a single weak
 * mention never tags a page.
 */

import type { ParsedPage } from '../types';

export interface Enrichment {
  /** ≤8 SIP-01-safe topic tags (lowercase, hyphenated), strongest first. */
  topics: string[];
  /** Document type for the SIP-01 §9.2 `type` extension tag. */
  docType: DocType;
  /** The site's own meta keywords (source evidence; not emitted verbatim). */
  sourceKeywords: string[];
}

export type DocType =
  | 'homepage'
  | 'article'
  | 'blog'
  | 'news'
  | 'docs'
  | 'wiki'
  | 'forum'
  | 'repository'
  | 'product'
  | 'video'
  | 'audio'
  | 'page';

/* ------------------------------------------------------------------------ */
/* Controlled topic vocabulary                                               */
/* ------------------------------------------------------------------------ */

/**
 * Canonical topic → aliases. Aliases are matched case-insensitively on word
 * boundaries against title/keywords/headings/description/URL. Normalization
 * happens HERE (Bitcoin/BITCOIN/Bitcoin-Core all land on `bitcoin`), never
 * by merging distinct concepts.
 */
const TOPIC_LEXICON: ReadonlyArray<[string, string[]]> = [
  // Decentralization & crypto
  ['bitcoin', ['bitcoin', 'btc', 'satoshi', 'sats']],
  ['lightning', ['lightning network', 'lightning', 'lnurl', 'bolt11']],
  ['nostr', ['nostr', 'npub', 'nsec', 'relay', 'zap', 'zaps']],
  ['cryptocurrency', ['cryptocurrency', 'crypto', 'altcoin', 'monero', 'ethereum']],
  ['privacy', ['privacy', 'private', 'anonymity', 'anonymous', 'surveillance']],
  ['censorship', ['censorship', 'censorship-resistant', 'free speech', 'censored']],
  ['cryptography', ['cryptography', 'encryption', 'pgp', 'cipher', 'hash']],
  ['tor', ['tor', 'onion', 'darknet', 'dark web']],
  ['vpn', ['vpn', 'wireguard', 'openvpn']],

  // Technology
  ['programming', ['programming', 'coding', 'software development', 'developer', 'dev']],
  ['javascript', ['javascript', 'js', 'ecmascript', 'node.js', 'nodejs']],
  ['typescript', ['typescript', 'ts']],
  ['python', ['python', 'python3', 'django', 'flask']],
  ['rust', ['rust', 'rustlang', 'cargo']],
  ['go', ['golang', 'go lang']],
  ['webdev', ['web development', 'webdev', 'html', 'css', 'frontend', 'front-end', 'react', 'svelte', 'vue']],
  ['opensource', ['open source', 'opensource', 'foss', 'free software', 'libre']],
  ['linux', ['linux', 'gnu', 'ubuntu', 'debian', 'arch linux', 'kernel']],
  ['selfhosting', ['self-hosted', 'selfhosted', 'self-hosting', 'homelab', 'home server']],
  ['ai', ['artificial intelligence', 'ai', 'llm', 'large language model', 'chatgpt', 'machine learning', 'ml', 'neural network', 'deep learning']],
  ['security', ['cybersecurity', 'infosec', 'vulnerability', 'exploit', 'malware', 'security']],
  ['databases', ['database', 'sql', 'sqlite', 'postgres', 'mysql', 'nosql']],
  ['devops', ['devops', 'docker', 'kubernetes', 'ci/cd', 'deployment', 'self-host']],
  ['hardware', ['hardware', 'cpu', 'gpu', 'raspberry pi', 'arduino', 'microcontroller']],
  ['3d-printing', ['3d printing', '3d-printing', '3d print', 'reprap']],
  ['electronics', ['electronics', 'circuit', 'pcb', 'soldering']],

  // Science & knowledge
  ['science', ['science', 'scientific', 'research', 'study', 'paper', 'journal']],
  ['space', ['space', 'nasa', 'astronomy', 'rocket', 'mars', 'spacex']],
  ['physics', ['physics', 'quantum', 'relativity']],
  ['mathematics', ['mathematics', 'math', 'algebra', 'calculus', 'statistics']],
  ['biology', ['biology', 'genetics', 'evolution', 'species']],
  ['climate', ['climate', 'global warming', 'carbon', 'renewable']],
  ['education', ['education', 'learning', 'tutorial', 'course', 'university', 'school']],
  ['history', ['history', 'historical', 'ancient', 'medieval']],
  ['philosophy', ['philosophy', 'ethics', 'stoicism', 'existentialism']],
  ['books', ['books', 'book', 'reading', 'novel', 'literature', 'library', 'ebook', 'audiobook']],
  ['writing', ['writing', 'writer', 'blogging', 'fiction', 'poetry']],

  // Culture & entertainment
  ['gaming', ['gaming', 'video game', 'videogame', 'gamer', 'esports', 'speedrun']],
  ['retro-gaming', ['retro gaming', 'retrogaming', 'emulation', 'emulator', 'rom', 'dos game', 'arcade']],
  ['music', ['music', 'album', 'song', 'band', 'artist', 'spotify', 'vinyl', 'concert']],
  ['movies', ['movie', 'film', 'cinema', 'documentary', 'imdb']],
  ['tv', ['tv show', 'series', 'episode', 'streaming', 'netflix']],
  ['memes', ['meme', 'memes', 'shitpost', 'funny', 'humor', 'comedy']],
  ['anime', ['anime', 'manga', 'otaku']],
  ['art', ['art', 'artist', 'illustration', 'painting', 'digital art']],
  ['photography', ['photography', 'photo', 'camera', 'lens']],
  ['design', ['design', 'ui', 'ux', 'typography', 'graphic design']],

  // Life & society
  ['news', ['news', 'breaking', 'headlines', 'journalism', 'press']],
  ['politics', ['politics', 'political', 'election', 'government', 'policy']],
  ['finance', ['finance', 'investing', 'stocks', 'trading', 'markets', 'portfolio']],
  ['economics', ['economics', 'economy', 'inflation', 'recession']],
  ['health', ['health', 'medical', 'medicine', 'fitness', 'nutrition', 'mental health']],
  ['food', ['food', 'recipe', 'cooking', 'cuisine', 'restaurant']],
  ['travel', ['travel', 'tourism', 'backpacking', 'destination']],
  ['sports', ['sports', 'football', 'soccer', 'basketball', 'tennis', 'olympics']],
  ['cars', ['cars', 'automotive', 'ev', 'electric vehicle', 'tesla']],
  ['gardening', ['gardening', 'garden', 'plants', 'permaculture']],
  ['diy', ['diy', 'maker', 'woodworking', 'crafts', 'hacks']],
  ['religion', ['religion', 'christianity', 'islam', 'buddhism', 'theology']],
];

interface TopicHit {
  score: number;
  evidence: number;
}

/** Count word-boundary occurrences of `needle` in lowercase `haystack`. */
function countMentions(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  const n = needle.toLowerCase();
  for (;;) {
    const at = haystack.indexOf(n, from);
    if (at === -1) break;
    const before = at === 0 ? ' ' : haystack[at - 1];
    const after = haystack[at + n.length] ?? ' ';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) count++;
    from = at + n.length;
  }
  return count;
}

const SCORE_THRESHOLD = 3;
const MAX_TOPICS = 8;

/** Derive topic tags from page evidence. Deterministic. */
export function deriveTopics(parsed: ParsedPage, url: string): string[] {
  const title = parsed.title.toLowerCase();
  const desc = parsed.description.toLowerCase();
  const keywords = parsed.keywords.join(' ').toLowerCase();
  const headings = parsed.headings.join(' ').toLowerCase();
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase().replace(/[-_/+.]/g, ' ');
  } catch {
    // URL already normalized upstream; ignore.
  }

  const hits = new Map<string, TopicHit>();

  for (const [canonical, aliases] of TOPIC_LEXICON) {
    let score = 0;
    let evidence = 0;
    for (const alias of aliases) {
      const kwHits = countMentions(keywords, alias);
      const titleHits = countMentions(title, alias);
      const headHits = countMentions(headings, alias);
      const descHits = countMentions(desc, alias);
      const pathHits = countMentions(path, alias);
      if (kwHits + titleHits + headHits + descHits + pathHits === 0) continue;
      score += kwHits * 3 + Math.min(titleHits, 2) * 3 + Math.min(headHits, 2) * 2 + Math.min(descHits, 2) * 2 + pathHits;
      evidence++;
    }
    if (score >= SCORE_THRESHOLD) {
      const existing = hits.get(canonical);
      if (!existing || existing.score < score) hits.set(canonical, { score, evidence });
    }
  }

  return [...hits.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, MAX_TOPICS)
    .map(([topic]) => topic);
}

/* ------------------------------------------------------------------------ */
/* Document type                                                             */
/* ------------------------------------------------------------------------ */

const JSONLD_TYPE_MAP: ReadonlyArray<[RegExp, DocType]> = [
  [/^newsarticle$/i, 'news'],
  [/article$/i, 'article'],
  [/^blogposting$/i, 'blog'],
  [/^videoobject$/i, 'video'],
  [/^audioobject$/i, 'audio'],
  [/^product$/i, 'product'],
  [/^qapage$|^discussionforumposting$/i, 'forum'],
  [/^techarticle$/i, 'docs'],
];

/** Classify the document type from page evidence + URL shape. */
export function classifyDocType(parsed: ParsedPage, url: string): DocType {
  const og = parsed.ogType ?? '';

  // JSON-LD is the strongest structured signal.
  for (const type of parsed.jsonLdTypes) {
    for (const [re, docType] of JSONLD_TYPE_MAP) {
      if (re.test(type)) return docType;
    }
  }

  // OpenGraph type next.
  if (og === 'article') return 'article';
  if (og.startsWith('video')) return 'video';
  if (og.startsWith('music') || og.startsWith('audio')) return 'audio';
  if (og === 'product') return 'product';

  // URL-shape heuristics (deliberately conservative).
  let pathname = '/';
  let hostname = '';
  try {
    const u = new URL(url);
    pathname = u.pathname.toLowerCase();
    hostname = u.hostname.toLowerCase();
  } catch {
    return 'page';
  }

  if (hostname === 'github.com' || hostname === 'gitlab.com' || hostname.endsWith('.github.io')) {
    return 'repository';
  }
  if (pathname === '/' || pathname === '') return 'homepage';
  if (/\/wiki\//.test(pathname)) return 'wiki';
  if (/\/(docs?|documentation|reference|manual)(\/|$)/.test(pathname)) return 'docs';
  if (/\/(blog|posts?|articles?)(\/|$)/.test(pathname)) return parsed.published ? 'article' : 'blog';
  if (/\/(news|press)(\/|$)/.test(pathname)) return 'news';
  if (/\/(watch|video|v\/)/.test(pathname)) return 'video';
  if (/\/(forum|threads?|topic|viewtopic|community)(\/|\.|$)/.test(pathname)) return 'forum';
  if (/\/(product|item|shop|store|buy)(\/|$)/.test(pathname)) return 'product';
  if (parsed.published) return 'article';

  return 'page';
}

/** Full enrichment pass over a parsed page. */
export function enrichPage(parsed: ParsedPage, url: string): Enrichment {
  return {
    topics: deriveTopics(parsed, url),
    docType: classifyDocType(parsed, url),
    sourceKeywords: parsed.keywords,
  };
}
