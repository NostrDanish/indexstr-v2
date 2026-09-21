/**
 * Relay-side validation parity port — UNCAGED Index Relay
 * `validateWebDocument` (src/web-document.ts:271-402 of
 * UNCAGED-Index-Relay-main, audited 2026-09-20).
 *
 * The relays are the STRICTEST SIP-01 consumer (audit §2.2): everything
 * `buildIndexEvent` can legally emit must pass here, and the deliberately
 * invalid corpus must fail here with the same reason class. This port is
 * TEST TOOLING ONLY (Node-only: uses `node:crypto` for sync SHA-256 like
 * the relay itself); it is not part of the browser runtime surface.
 *
 * The regex/validation table is kept byte-identical to the relay source —
 * do not "improve" it: drift here means the smoke test stops detecting
 * real relay rejections.
 */

import { createHash } from 'node:crypto';

/** Minimal structural event type (what the validator reads). */
export interface RelayEvent {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  pubkey: string;
  id?: string;
  sig?: string;
}

/** Event kind for SIP-01 Web Index Observations (addressable range). */
export const WEB_DOCUMENT_KIND = 39697;

/** Current SIP-01 schema version (the `v` tag). */
export const WEB_DOCUMENT_SCHEMA_VERSION = "1";

/** Prefix of the URL-identity `d` tag (SIP-01 §3). */
export const WEB_DOCUMENT_D_PREFIX = "widx:";

/** Maximum length of the `u` tag value. */
export const WEB_DOC_URL_MAX_LENGTH = 2048;

/** Title length cap (SIP-01 §5): 1–300 chars after trim. */
export const WEB_DOC_TITLE_MAX_LENGTH = 300;

/** Description length cap (SIP-01 §6). */
export const WEB_DOC_DESCRIPTION_MAX_LENGTH = 1000;

/** Maximum number of topic (`t`) tags (SIP-01 §6). */
export const WEB_DOC_MAX_TOPICS = 8;

/** Generous cap for the NIP-31 `alt` description. */
const ALT_MAX_LENGTH = 1000;

/** Cap for the informational `source` tag. */
const SOURCE_MAX_LENGTH = 100;

/**
 * Tracking parameters stripped during SIP-01 §7 URL normalization. All other
 * query parameters are preserved (many are semantically required).
 */
const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "dclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref_src",
  "spm",
  "si",
] as const;

/** Lookup set for {@link TRACKING_PARAMS} (matched case-insensitively). */
const TRACKING_SET: ReadonlySet<string> = new Set(TRACKING_PARAMS);

/** ISO 639-1 two-letter language code (the `l` tag). */
const LANG_RE = /^[a-z]{2}$/;

/** Lowercase topic tag value (SIP-01 §6: `t` tags are lowercase topics). */
const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** Extension tag values: `page`, `repository`, `github`, `onion`, `DE`, ... */
const EXTENSION_VALUE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}$/;

/** MIME type with optional parameters: `text/html; charset=utf-8`. */
const MIME_RE = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}(;\s*[^\s;=]+=[^\s;]+)*$/;

/** Parsed content JSON of a web index observation. */
export interface WebDocumentContent {
  title: string;
  description?: string;
  image?: string;
}

/**
 * Normalize a URL per SIP-01 §7 (relay-side copy — byte-identical behavior
 * to the reference implementation is the whole point of the exercise).
 * Returns `undefined` when the input is not a valid http(s) URL.
 */
export function relayNormalizeIndexUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

  // 2. Strip a leading www. (scheme/host are lowercased by the parser).
  if (url.hostname.startsWith("www.")) {
    url.hostname = url.hostname.slice(4);
  }

  // 4. Fragment.
  url.hash = "";

  // 5–6. Drop tracking parameters (case-insensitively — `UTM_SOURCE` is as
  // much a tracker as `utm_source`), then sort the rest by key. Assigning
  // `url.search` unconditionally also normalizes away a bare trailing `?`.
  const entries = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_SET.has(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sorted = new URLSearchParams();
  for (const [key, value] of entries) sorted.append(key, value);
  url.search = sorted.toString();

  // 7. Trailing slash (keep the bare root "/").
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

/**
 * The SIP-01 §3 `d` tag value for a normalized URL:
 * `"widx:" + sha256(url)[0:32]` (lowercase hex).
 */
export function relayWebDocumentDTag(normalizedUrl: string): string {
  const hash = createHash("sha256").update(normalizedUrl, "utf8").digest("hex");
  return `${WEB_DOCUMENT_D_PREFIX}${hash.slice(0, 32)}`;
}

/**
 * The SIP-01 §8 content identity: lowercase hex SHA-256 of
 * `title + "\n" + description` (empty string when description is absent).
 */
export function relayWebDocumentContentHash(
  title: string,
  description?: string,
): string {
  return createHash("sha256")
    .update(`${title}\n${description ?? ""}`, "utf8")
    .digest("hex");
}

/** All values of the tags with the given name that carry a value. */
function tagValues(event: RelayEvent, name: string): string[] {
  return event.tags.filter((t) => t[0] === name && t[1]).map((t) => t[1]);
}

/** The single value of a tag expected at most once, or undefined. */
function tagValue(event: RelayEvent, name: string): string | undefined {
  return tagValues(event, name)[0];
}

/**
 * Parse the content JSON of a web document event. Returns undefined when the
 * content is not a JSON object or the required `title` is not a string.
 */
export function parseWebDocumentContent(
  content: string,
): WebDocumentContent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const { title, description, image } = parsed as Record<string, unknown>;
  if (typeof title !== "string") return undefined;
  return {
    title,
    ...(typeof description === "string" && { description }),
    ...(typeof image === "string" && { image }),
  };
}

/**
 * Validate a kind 39697 web index observation for ingestion — VERBATIM port
 * of UNCAGED Index Relay `validateWebDocument`.
 *
 * Returns a human-readable reason string (without the `invalid:` prefix) when
 * the event is malformed, or `undefined` when it is acceptable.
 */
export function validateWebDocument(event: RelayEvent): string | undefined {
  if (event.kind !== WEB_DOCUMENT_KIND) return undefined;

  // --- Required tags: exactly one d, u, v, alt each.

  const dTags = event.tags.filter((t) => t[0] === "d");
  if (dTags.length === 0 || !dTags[0][1]) return "web document missing d tag";
  if (dTags.length > 1) return "web document has multiple d tags";
  const dTag = dTags[0][1];

  const uTags = event.tags.filter((t) => t[0] === "u");
  if (uTags.length === 0 || !uTags[0][1]) return "web document missing u tag";
  if (uTags.length > 1) return "web document has multiple u tags";
  const uTag = uTags[0][1];

  const vTags = event.tags.filter((t) => t[0] === "v");
  if (vTags.length === 0 || !vTags[0][1]) return "web document missing v tag";
  if (vTags.length > 1) return "web document has multiple v tags";
  if (vTags[0][1] !== WEB_DOCUMENT_SCHEMA_VERSION) {
    return `unsupported web document schema version "${vTags[0][1]}"`;
  }

  const altTags = event.tags.filter((t) => t[0] === "alt");
  if (altTags.length === 0 || !altTags[0][1]?.trim()) {
    return "web document missing alt tag";
  }
  if (altTags.length > 1) return "web document has multiple alt tags";
  if (altTags[0][1].length > ALT_MAX_LENGTH) {
    return `alt tag exceeds ${ALT_MAX_LENGTH} characters`;
  }

  // --- URL allowlist + d ↔ normalized u consistency (SIP-01 §7, §11).

  if (uTag.length > WEB_DOC_URL_MAX_LENGTH) {
    return `u tag exceeds ${WEB_DOC_URL_MAX_LENGTH} characters`;
  }
  const normalized = relayNormalizeIndexUrl(uTag);
  if (!normalized) return "u tag is not a valid http(s) URL";
  if (dTag !== relayWebDocumentDTag(normalized)) {
    return "d tag does not match the normalized u tag (widx: + sha256(u)[0:32])";
  }

  // --- Content JSON: title is required (1–300 trimmed), description and
  // --- image optional with caps.

  const content = parseWebDocumentContent(event.content);
  if (!content) return "web document content is not valid JSON with a title";

  const trimmedTitle = content.title.trim();
  if (
    trimmedTitle.length === 0 ||
    trimmedTitle.length > WEB_DOC_TITLE_MAX_LENGTH
  ) {
    return `title must be 1-${WEB_DOC_TITLE_MAX_LENGTH} characters`;
  }
  if (
    content.description !== undefined &&
    content.description.length > WEB_DOC_DESCRIPTION_MAX_LENGTH
  ) {
    return `description exceeds ${WEB_DOC_DESCRIPTION_MAX_LENGTH} characters`;
  }
  if (content.image !== undefined) {
    let imageUrl: URL | undefined;
    try {
      imageUrl = new URL(content.image);
    } catch {
      imageUrl = undefined;
    }
    if (imageUrl?.protocol !== "https:") {
      return "image must be an https URL";
    }
  }

  // --- Optional tags, validated when present.

  const topics = event.tags.filter((t) => t[0] === "t");
  if (topics.length > WEB_DOC_MAX_TOPICS) {
    return `web document has more than ${WEB_DOC_MAX_TOPICS} topic tags`;
  }
  for (const topic of topics) {
    if (!topic[1] || !TOPIC_RE.test(topic[1])) {
      return "topic (t) tags must be lowercase alphanumeric words";
    }
  }

  const lang = tagValue(event, "l");
  if (lang !== undefined && !LANG_RE.test(lang)) {
    return "l tag is not a valid ISO 639-1 language code";
  }

  // The x tag is the content-agreement signal; an incorrect hash is worse
  // than none, so it is verified against the observed metadata (SIP-01 §8).
  const x = tagValue(event, "x");
  if (x !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(x)) {
      return "x tag must be a lowercase hex sha256 digest";
    }
    if (x !== relayWebDocumentContentHash(content.title, content.description)) {
      return "x tag does not match sha256(title + \\n + description)";
    }
  }

  const published = tagValue(event, "published");
  if (published !== undefined && !/^\d{1,16}$/.test(published)) {
    return "published tag must be a unix timestamp in seconds";
  }

  const source = tagValue(event, "source");
  if (source !== undefined && source.length > SOURCE_MAX_LENGTH) {
    return `source tag exceeds ${SOURCE_MAX_LENGTH} characters`;
  }

  // Optional extension tags (SIP-01 §9): free-form but keyword-shaped.
  for (const name of ["type", "platform", "category", "network"]) {
    const value = tagValue(event, name);
    if (value !== undefined && !EXTENSION_VALUE_RE.test(value)) {
      return `${name} tag is not a valid keyword`;
    }
  }

  const country = tagValue(event, "country");
  if (country !== undefined && !/^[a-zA-Z]{2}$/.test(country)) {
    return "country tag must be an ISO 3166-1 alpha-2 code";
  }

  const mime = tagValue(event, "mime");
  if (mime !== undefined && !MIME_RE.test(mime)) {
    return "mime tag is not a valid MIME type";
  }

  return undefined;
}
