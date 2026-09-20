# Indexstr — Event Kinds & Protocol Reference

Indexstr is a **browser-based web indexer** (a [Crawlstr](https://github.com/NostrDanish/Crwalstr) fork)
that ships with **curated URL collections** and publishes to the **shared SIP-01
(Search Index Protocol) index** on Nostr. It implements the **canonical SIP-01
specification v1.2** — [github.com/NostrDanish/SIP-01](https://github.com/NostrDanish/SIP-01)
(`public/spec/SIP-01.md`) — byte-compatibly with
[0xSearchstr](https://github.com/NostrDanish/0xSearchstr),
[0xPresearchstr](https://github.com/NostrDanish/0xPresearchstr),
[UNCAGED-ENGINE](https://github.com/NostrDanish/UNCAGED-ENGINE), and the
[UNCAGED Index Relay](https://github.com/NostrDanish/UNCAGED-Index-Relay).

## Protocol Compatibility

| Schema | Kind | Type | Status |
|--------|------|------|--------|
| Web Index Observation (SIP-01) | **39697** | addressable | **Written** by Indexstr |
| Indexstr Node Heartbeat | **16919** | replaceable | **Written** by Indexstr |

Indexstr is a **pure SIP-01 publisher** for observations — it does NOT write
community submissions (kind 30078) or query caches. Kind 16919 is an
Indexstr-specific coordination/health event documented below.

## Deterministic Crawl Sharding (no coordinator)

Every normalized URL maps to one of **256 shards**. Every node has a **home
shard** derived from its indexer pubkey. Nodes prefer home-shard work, so a
hundred nodes loading the same collection split it instead of duplicating it.

```
shard(url)  = fnv1a32_utf16(normalized_url) >> 24     // top byte → 0..255
home(node)  = parseInt(indexer_pubkey_hex[0:2], 16)   // first pubkey byte
```

FNV-1a (specified here so any implementation can reproduce it):

```
hash := 2166136261                        // 0x811c9dc5
for each UTF-16 code unit's low byte b (folding high byte for cp > 0xFF):
    hash := (hash XOR b) * 16777619 mod 2^32
shard := hash >> 24
```

Scheduling is **preferential, not exclusive**: a node picks home-shard jobs
first but samples other shards with probability 0.25. Sparse network → full
coverage; dense network → cross-shard work becomes bounded redundancy
(independent observations — the SIP-01 confidence signal).

The URL→shard hash deliberately is NOT SHA-256: sharding needs cheap,
synchronous bulk computation (50k URLs at seed time) and uniform spread, not
cryptographic identity — URL identity remains the SIP-01 `d` tag.

## Kind 16919 — Indexstr Node Heartbeat

A replaceable event (latest per pubkey) announcing "this node is alive and
indexing". Published on crawler start and every 10 minutes while running.
Consumers treat heartbeats older than **1 hour** as offline.

> This schema is now the **canonical heartbeat port** in the SIP-01 repo
> (`src/lib/heartbeat.ts` — the spec site's dashboard consumes it read-only).
> Parsers on both sides accept lowercase hex shards and normalize to
> uppercase; readers collapse to the latest event per pubkey
> (`dedupeHeartbeats`) before applying the TTL (`isNodeLive`).

```json
{
  "kind": 16919,
  "pubkey": "<device indexer pubkey>",
  "created_at": 1786250000,
  "content": "{\"v\":\"1\",\"shard\":\"C4\",\"platform\":\"desktop\",\"network\":\"wifi-or-better\",\"charging\":true,\"stats\":{\"pagesIndexed\":1204,\"queueSize\":18311,\"published\":1198}}",
  "tags": [
    ["v", "1"],
    ["shard", "C4"],
    ["source", "indexstr/1"],
    ["alt", "Indexstr node heartbeat: shard C4"]
  ]
}
```

**Tags:** `v` (node protocol version), `shard` (home shard, two uppercase hex
chars), `source` (`indexstr/1`), `alt` (NIP-31 human-readable).

**Content** (JSON): `v`, `shard`, coarse `platform` (`mobile`/`desktop`),
coarse `network` class, `charging`, and self-reported `stats`
(`pagesIndexed`, `queueSize`, `published`).

**Privacy contract:** no location, no IP, no device model, no fine-grained
fingerprint. Battery/network are deliberately coarse classes.

**Trust contract:** heartbeats are *self-reported* — usable for network
health/coverage estimates only. Reputation MUST be derived from signed
kind 39697 observations (independent and comparable across indexers), never
from heartbeat claims.

**Querying (network estimate):**

```json
{ "kinds": [16919], "since": <now - 3600>, "limit": 500 }
```

Count distinct `pubkey` values. This is a local estimate bounded by the
queried relays — never a global census.

## What Indexstr Writes

### Kind 39697 — Web Index Observation (SIP-01)

One addressable event per `(crawler's indexer pubkey, normalized URL)` — a signed
statement: *"This device observed this web page at this time, and here is its
public metadata."*

```json
{
  "kind": 39697,
  "pubkey": "<device indexer pubkey, hex>",
  "created_at": 1786250000,
  "content": "{\"title\":\"Example Page\",\"description\":\"A page about...\",\"image\":\"https://example.com/og.jpg\"}",
  "tags": [
    ["d", "widx:9f86d081884c7d659a2feaa0c55ad015"],
    ["u", "https://example.com/page"],
    ["l", "en"],
    ["x", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["v", "1"],
    ["published", "1786200000"],
    ["source", "indexstr/1"],
    ["network", "clearnet"],
    ["type", "page"],
    ["alt", "Web index observation: Example Page"]
  ]
}
```

**Core tags (spec §5/§6):**

| Tag | Required | Meaning |
|-----|----------|---------|
| `d` | ✔ | `"widx:" + sha256(normalized_url)[0:32]` — URL identity, identical across all indexers |
| `u` | ✔ | Canonical URL (http/https only, ≤ 2048 chars, normalized per SIP-01 §7) |
| `v` | ✔ | Schema version `"1"` |
| `x` | ✔ | Content hash: `sha256(title + "\n" + description)` (§8) |
| `alt` | ✔ | Human-readable summary (the `alt` convention; spec §12.3) |
| `l` | – | ISO 639-1 language code (validated two-letter shape) |
| `t` | – | 0–8 lowercase topic tags matching `^[a-z0-9][a-z0-9-]{0,99}$` |
| `published` | – | Unix seconds — page's claimed publication time (§12.2) |
| `source` | – | `"indexstr/1"` — identifies this software (≤ 100 chars) |

**Extension tags (spec §9.2 registry):**

| Tag | Value | Meaning |
|-----|-------|---------|
| `network` | always `clearnet` | A browser crawler can only reach the clearnet |
| `type` | `page` / `article` / `blog` / `news` / `docs` / `wiki` / `forum` / `repository` / `product` / `video` / `audio` / `homepage` | Derived document type (see Enrichment) |
| `platform` | e.g. `github`, `youtube`, `wikipedia` | Emitted for well-known hosts only |

## Enrichment (derived `t` topics + `type`)

Crawlstr says *"I found this."* Indexstr says *"I verified, classified and
enriched this."* Enrichment rides the **existing SIP-01 slots** — topics in
`t`, document type in `type` — so events stay byte-compatible with every
SIP-01 consumer. No new kind, no schema break, no evidence payloads on the
wire.

**Deterministic classification.** Topics come from a controlled vocabulary
(~70 canonical topics with aliases) matched against page evidence:

| Evidence | Weight |
|----------|--------|
| meta keywords (source claims) | ×3 |
| `<title>` | ×3 |
| h1/h2 headings | ×2 |
| meta description | ×2 |
| URL path | ×1 |

A topic is emitted only at score ≥ 3 (a stray body mention never tags a
page), max 8 per event, normalized to canonical lowercase-hyphenated form
(`Bitcoin`/`BITCOIN` → `bitcoin`). No AI, no network calls, no external
service: **two Indexstr nodes classifying the same page produce the same
tags** — reproducibility IS the provenance story, and cross-node tag
agreement is itself a verifiable confidence signal.

Document type is classified from JSON-LD `@type` → `og:type` → URL-shape
heuristics, in that order of strength. Weak evidence → plain `page`.

**What is deliberately NOT on the event:** confidence scores, evidence
lists, source-vs-derived tag splits. Those are derivable by replaying the
documented algorithm; the event carries conclusions only.

## Network Discovery Intake

Indexstr consumes the shared index as a *discovery feed*: while running, a
node queries recent kind 39697 events from its relay pool every 2 minutes
and enqueues URLs it has never crawled — the Crawlstr→Indexstr pipeline
over Nostr with zero coupling between implementations.

Intake jobs: priority 0.5, `followLinks: false` (the network points at
pages; re-verification is this node's own crawl).

Abuse guards on all discovered/intake URLs (never on curated collections):

- crawl-trap filter (session keys, param explosions, segment loops,
  counter paths, extreme depth — see `traps.ts`)
- per-domain caps (200/domain intake, 500/domain link discovery)
- **per-indexer cap** (100 URLs per indexer pubkey per session) — the Sybil
  guard: a flooding pubkey can't turn listening nodes into its crawl army,
  even spread across thousands of domains
- structural sanity: `d` must be `widx:`-shaped, `u` present, event age ≤ 24h
- SSRF guard: private/loopback/link-local/CGNAT/mapped-IPv6 targets are
  refused before any request (direct or proxied); redirect targets re-checked
- 150k total queue ceiling
- own-pubkey exclusion

Intake rejections are counted (`intakeRejected` stat) as network telemetry.

## Freshness / Recrawl Semantics

Every successfully crawled URL is re-enqueued with `nextAttempt` at an
adaptive interval: first crawl → 24h; unchanged recrawl → interval doubles
(max 30d); changed content → back to 24h. Change detection = sha256 of
extracted text.

A recrawl **republishes** the observation even when content is unchanged:
same `d`, same `x`, fresh `created_at` — per (indexer, URL) replaceable
semantics this reads as *"still alive at this time"*, the network's
freshness signal, at zero extra index space.

**Key properties (same as all SIP-01 publishers):**

- **Per-device indexer identity** — each browser generates its own anonymous keypair
  on first use (`localStorage: sip:indexer:secret`). Never the user's personal key (§14).
- **No query leakage** — the event contains a URL and public page metadata, never
  what anyone searched for (§16).
- **URL normalization** — identical to SIP-01 §7: strips tracking params, lowercases
  scheme/host, removes `www.`, sorts query params, removes fragments. Verified
  byte-identical against the §13 test vectors.
- **Deduplication** — the `d` tag is deterministic from the normalized URL; the
  `x` tag is a content agreement signal. Multiple crawlers observing the same page
  produce events with the same `d` — search nodes count distinct authors.
- **Addressable** — re-crawling the same URL replaces the previous observation
  (one slot per indexer per URL).

## How Indexstr Differs from Other SIP-01 Publishers

| Feature | 0xSearchstr / UNCAGED | Indexstr |
|---------|----------------------|----------|
| **Trigger** | Search results surfaced by providers | Active web indexing |
| **Discovery** | Search results from external APIs | Bundled curated URL collections + manual seeds |
| **Depth** | 1 (direct results only) | 0 for collections (exact URLs), up to 3 for manual seeds |
| **Rate limiting** | N/A (API-driven) | Per-domain, configurable |
| **robots.txt** | N/A | Respected (configurable) |
| **Queue** | N/A | IndexedDB persistent queue |
| **Power management** | N/A | Battery/WiFi/bandwidth aware |

The **event schema is identical**. The difference is only in how URLs are discovered.

## Relay Publishing

Indexstr pushes every observation and heartbeat to the full publish pool —
SIP-01 index relays first, then NIP-50 search relays, then broad-propagation
relays (`src/crawler/relays.ts`). Users can extend the pool with custom
relays in Settings (persisted on-device, applied per publish cycle);
built-ins are fixed. Relays that fail 8+ times with zero successes in a
session are skipped automatically (auto-rotation).

**Relay auto-discovery:** candidates come from public NIP-66 monitor data
(kind 30166 filtered by `N:50` / `k:39697`) and are verified against their
own NIP-11 documents for `supported_nips: [50]` and the `uncaged_index`
SIP-01 block (spec §15). Discovered relays are never joined silently — the
user adds them. Any relay can also be probed on demand from Settings.

The read side (network intake, network estimates) queries the publish pool
plus the NIP-50 search pool, including read-only `search.nos.today`.

## Reading the Index

Any SIP-01 compatible search engine can read Indexstr's observations:

```json
{
  "kinds": [39697],
  "#d": ["widx:9f86d081884c7d659a2feaa0c55ad015"]
}
```

Or browse by topic:

```json
{
  "kinds": [39697],
  "#t": ["nostr"],
  "limit": 50
}
```

Or query full-text via NIP-50 on SIP-01-aware relays, using the web-search
operators from spec §15 (`site:`, `title:`, `lang:`, `after:`, …):

```json
{
  "kinds": [39697],
  "search": "bitcoin privacy site:nostr.com lang:en after:2026-01-01",
  "limit": 20
}
```

## Trust Model

- Indexstr observations are **structurally trusted** — any indexer pubkey is accepted.
- Events are validated on parse: schema version, URL allowlist, field caps.
- Agreement across independent indexers (same `d`, different `pubkey`) is the
  ranking signal.
- Indexstr is just one more independent indexer in the SIP-01 ecosystem.
- Heartbeats (16919) are health metadata, not evidence: they carry a privacy
  floor (coarse classes only) and no trust weight.

## Offline-First Publishing

Signed observations that reach zero relays are held in a local IndexedDB
**outbox** (cap 5000) and re-published on reconnect, on crawler start, and
every 5 minutes while running. A node going offline costs the network
nothing, and the node loses no work.

## References

- **Canonical spec (v1.2):** [NostrDanish/SIP-01](https://github.com/NostrDanish/SIP-01) — `public/spec/SIP-01.md`
  (v1.2 was a NIP-reference audit; the wire format is unchanged and `v` stays `"1"`)
- **Implementation guide:** [SIP-01/docs/IMPLEMENTATION-GUIDE.md](https://github.com/NostrDanish/SIP-01/blob/main/docs/IMPLEMENTATION-GUIDE.md)
- **Reference port:** [SIP-01/src/lib/sip01-utils.ts](https://github.com/NostrDanish/SIP-01/blob/main/src/lib/sip01-utils.ts)
- **0xSearchstr NIP.md:** [legacy schemas, community submissions, Nostra interop](https://github.com/NostrDanish/0xSearchstr/blob/main/NIP.md)
- **UNCAGED-ENGINE NIP.md:** [reference implementation schemas](https://github.com/NostrDanish/UNCAGED-ENGINE/blob/main/NIP.md)
- **UNCAGED Index Relay:** [validating relay profile](https://github.com/NostrDanish/UNCAGED-Index-Relay)
