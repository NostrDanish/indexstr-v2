# Indexstr v2

> **v2.1 note:** Indexstr is a **self-contained single app** again — no
> monorepo, no pnpm workspace, no cross-package builds. The SIP-01 wire
> format (`src/protocol/`) and the full deep-crawler engine
> (`src/crawler/`) live in this tree, so `npm install && npm run build`
> just works — including on Vercel with zero monorepo config. All **eight
> curated collection DBs ship in `public/collections/`** (they were the
> "MISSING BINARIES" of v2.0). Nodes identify as `source=indexstr/v2`.

<p align="center">
  <img src="public/brand/logo.png" alt="Indexstr — a spider sitting in its web" width="192" height="192">
</p>

**Indexstr — the decentralized web indexing network.** Turn spare browser, mobile and desktop capacity into a censorship-resistant, Nostr-powered web index. A fork/evolution of [Crawlstr](https://github.com/NostrDanish/Crwalstr) that ships with **curated URL collections built in** and coordinates crawl work across nodes **without any central server**. No backend. No tracking. No accounts required.

Load a collection, press **Start Crawling**, and every page becomes a **kind 39697 web index observation** on the shared [SIP-01](https://github.com/NostrDanish/SIP-01) index — instantly searchable by [0xSearchstr](https://0xsearchstr.shakespeare.wtf), [0xPresearchstr](https://presearchstr.shakespeare.wtf), [UNCAGED](https://uncaged.shakespeare.wtf), and any future SIP-01 compatible client.

## What's New in the v2.1 Refresh

Same SIP-01 wire format (`v` stays `"1"`, kind 39697, byte-compatible
`d`/`x`) — this refresh ports the v3 hardening onto the v2 identity.
Observations stay tagged `source=indexstr/v2`, heartbeats carry node
version `"2"`.

| | v2.0 | v2.1 (this) |
|---|---|---|
| **Repo shape** | pnpm monorepo (`packages/*` + `apps/*`) — the thing that kept breaking Vercel deploys | **Single self-contained app**: `npm install && npm run build`, deploys anywhere |
| **Collection DBs** | "MISSING BINARIES" — 8 SQLite DBs had to be copied in by hand; sqlite tests failed without them | **All 8 DBs committed** in `public/collections/` (~76 MB) — tests and the app work out of the box |
| **Retry backoff** | Cap applied before jitter — a capped 10-minute retry could inflate to 12.5 min | Cap applied **after** jitter — the 10-minute ceiling is hard |
| **Stop handling** | `sleep()` hung until its timeout when stop fired before the sleep began | Already-aborted signals resolve immediately |
| **Heartbeat version** | `v:"1"` even for v2 software — the dashboard couldn't tell generations apart | `v:"2"` + `source=indexstr/v2`, threaded through `HeartbeatConfig.nodeVersion` |
| **Bandwidth cap** | Minimum 25 MB | **Unlimited** option in Settings — turn the cap fully off and it just runs |
| **Icons** | `/brand/logo.png` missing from the monorepo slice — favicon/PWA icons 404 | Brand assets ship in `public/brand/` |

Source-tag history: v1 nodes emit `indexstr/1`, v2 nodes `indexstr/v2`
(unchanged by this refresh). All remain valid SIP-01; dashboards can tell
the traffic apart.

## A Network, Not Just a Crawler

Crawlstr = *"let your browser crawl the web."*
Indexstr = *"turn the community into a distributed indexing network."*

```
                INDEXSTR NETWORK
                      │
        ┌─────────────┼─────────────┐
        │                           │
   Seed sources               Nostr index
   (modular providers)        (SIP-01 observations)
        │                           │
        ▼                           ▼
  ┌───────────┐              ┌─────────────┐
  │ Sharded   │              │  Search     │
  │ work queue│              │  engines    │
  └─────┬─────┘              └─────────────┘
        │
   ┌────┴─────┬──────────┐
   ▼          ▼          ▼
 Browser   Mobile     Desktop
 node A    node B     node C
 (shard C4)(shard 19)(shard A7)
```

- **Deterministic sharding** — every URL belongs to one of 256 shards; every node has a home shard derived from its indexer pubkey. Nodes prefer their own shard, so the community splits the crawl space instead of duplicating it. No coordinator, no registration — same seeds in, same assignment out.
- **Node heartbeats (kind 16919)** — running nodes publish a small signed, privacy-minimal heartbeat (shard, coarse platform/network, counters). Querying recent heartbeats gives a local estimate of active indexers and shard coverage.
- **Offline-first** — observations that can't reach any relay wait in a persistent outbox and flush on reconnect. Going offline loses nothing.
- **Modular discovery** — seed sources implement a small `SeedProvider` interface (`src/crawler/providers.ts`); the bundled collections are just the first providers. RSS watchers, community seed lists, and dataset importers slot in without touching the crawler.
- **Enrichment layer** — every crawled page is classified deterministically: topics (controlled vocabulary, evidence-weighted, ≤8 per page) ride SIP-01 `t` tags, document type rides the `type` extension. No AI required; any node replaying the algorithm reproduces the tags, so classification agreement is verifiable.
- **Network discovery intake** — while running, a node reads *other* indexers' kind 39697 observations and queues URLs it has never seen. Every crawler on the network becomes every other node's discovery sensor.
- **Freshness scheduling** — crawled URLs recrawl on adaptive intervals (24h → doubling → 30d cap; change resets). Unchanged recrawls republish the same `d`/`x` with fresh `created_at`: the network's "still alive" signal.
- **Abuse guards** — crawl-trap heuristics, per-domain discovery caps, per-indexer intake caps (Sybil guard), 150k queue ceiling, per-domain rate limits, robots.txt.
- **SSRF guard** — private/loopback/link-local/CGNAT/mapped-IPv6 targets are refused before any request, direct *or* proxied; redirect targets re-checked. The proxy is never asked to reach inward.
- **Hard resource limits** — session bandwidth cap and a global pages/hour sliding window are actually enforced in the crawl loop (not just settings-page decoration), plus per-domain delays and a serial-by-design crawl loop.

Full protocol details: [NIP.md](NIP.md).

---

## The Collections

Eight curated link packs ship inside the app as SQLite databases, parsed locally in your browser (see `src/crawler/sqlite.ts` — a tiny read-only SQLite reader written for this purpose):

| Collection | Contents | Size |
|------------|----------|------|
| **Top Sites** | High-traffic websites, news aggregators, community threads | ~26 MB |
| **Awesome Lists** | Curated awesome-* lists — the best tools and resources per topic | ~20 MB |
| **RSS Feeds** | RSS and Atom feeds across tech, science, news and culture | ~19 MB |
| **Music** | Artists, labels, streaming pages, music communities | ~10 MB |
| **Books** | Digital libraries, book search engines, reading platforms | ~1.3 MB |
| **Movies** | Film databases, streaming indexes, cinema resources | ~1.2 MB |
| **Memes** | Meme archives, humor sites, internet culture | ~1 MB |
| **Video Games** | Game databases, stores, mods, gaming communities | ~0.9 MB |

Databases download on demand (only the collection you load), parse in a couple of seconds, and the extracted URL list is cached in IndexedDB — reloading a collection later is instant. Collection URLs are indexed **exactly as listed** (`followLinks: false`): the collection IS the crawl plan.

The databases ship in `public/collections/` **and** are mirrored as content-addressed [Blossom](https://github.com/hzrd149/blossom) blobs (`blossom.primal.net/<sha256>`). The loader tries the local file first, then Blossom, then Blossom via CORS proxy — downloaded bytes are always verified against their SHA-256 (the Blossom blob id), so any transport is safe. Hosts that can't serve large static binaries (some dev sandboxes) transparently fall back to Blossom.

---

## How It Works

```
You load a curated collection (or seed URLs manually)
       │
       ▼
┌─────────────┐
│   Crawler   │  IndexedDB queue, persistent across sessions
│   Engine    │  Battery/WiFi/bandwidth aware
└──────┬──────┘
       │
       ▼
   Fetch page (respects robots.txt, rate-limited per domain)
       │
       ▼
   Parse HTML (title, description, text, links, language)
       │
       ▼
   SHA-256 content hash (dedup across the network)
       │
       ▼
   Sign kind 39697 event with per-device indexer key
       │
       ▼
   Publish to Nostr relays (SIP-01)
       │
       ▼
┌──────────────────────────────────────┐
│        Shared SIP-01 Index           │
│                                      │
│  0xSearchstr reads it                │
│  0xPresearchstr reads it             │
│  UNCAGED reads it                    │
│  Your fork reads it                  │
│  Any SIP-01 client reads it          │
└──────────────────────────────────────┘
```

---

## What Makes This Different

Crawlstr made every browser a potential crawler. Indexstr answers the next question: *"crawl what, exactly?"* — with thousands of curated URLs loaded and ready.

| Feature | Description |
|---------|-------------|
| **Bundled collections** | 8 curated URL packs, from top sites to memes |
| **In-browser SQLite** | Collection databases parsed client-side by a purpose-built reader |
| **Opt-in only** | Nothing runs without explicitly pressing "Start Crawling" |
| **SIP-01 native** | Same protocol as 0xSearchstr, 0xPresearchstr, UNCAGED — one shared index |
| **Per-device identity** | Anonymous indexer keypair, separate from your Nostr identity |
| **No query leakage** | Events contain page metadata only — never what anyone searched for |
| **Resource aware** | Battery, WiFi, bandwidth limits. Eco mode. Charging-only mode. |
| **robots.txt** | Respected by default (configurable) |
| **Rate limited** | Seconds between requests per domain — slow, respectful, unstoppable |
| **Persistent queue** | IndexedDB-backed, survives browser restarts |
| **PWA** | Installable, works on mobile and desktop |

---

## Quick Start

Requires Node.js ≥ 20. No pnpm, no workspace — plain npm:

```bash
npm install
npm run dev      # http://localhost:8080
npm test         # tsc + eslint + vitest (500+ tests) + production build
npm run build    # → dist/
```

Deploys anywhere static: Vercel/Netlify/GitHub Pages with framework preset
"Vite", build `npm run build`, output `dist`.

Open the printed URL, open the **Collections** tab, load a pack, press **Start Crawling**.

---

## Usage

### Load a Collection

The **Collections** tab shows the eight bundled packs with URL counts and samples. **Load into queue** downloads the database, extracts every URL (normalized per SIP-01 §7, deduped, already-crawled pages skipped), and enqueues them at depth 0 — each URL is indexed as-is, no link following.

Large collections take days to work through at a respectful per-domain pace. That is by design: the queue persists across restarts and churns steadily whenever the crawler is on.

### Seed a URL manually

The **Seed URLs** tab still works exactly like Crawlstr: enter any URL and the crawler follows links up to depth 3.

```
https://bitcoin.org
```

### Crawler Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **WiFi Only** | Off | Only crawl on WiFi networks |
| **Charging Only** | Off | Only crawl while device is charging |
| **Respect robots.txt** | On | Follow website crawling policies |
| **Eco Mode** | On | Slower crawling, less resource usage |

### Indexer Identity

Each browser gets its own anonymous indexer keypair (visible in the dashboard). This key signs all kind 39697 observations. It is:

- **Pseudonymous** — not linked to your personal Nostr identity
- **Replaceable** — regenerating creates a new indexer
- **Local** — the secret key never leaves your browser
- **Exportable** — for backup or migration

---

## Protocol

Indexstr publishes **SIP-01 (Search Index Protocol)** events — the same protocol used by the entire Searchstr ecosystem.

### Kind 39697 — Web Index Observation

```json
{
  "kind": 39697,
  "pubkey": "<device indexer pubkey>",
  "created_at": 1786250000,
  "content": "{\"title\":\"Example Page\",\"description\":\"A page about...\"}",
  "tags": [
    ["d", "widx:9f86d081884c7d659a2feaa0c55ad015"],
    ["u", "https://example.com/page"],
    ["l", "en"],
    ["x", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["v", "1"],
    ["source", "indexstr/v2"],
    ["network", "clearnet"],
    ["type", "page"],
    ["alt", "Web index observation: Example Page"]
  ]
}
```

| Tag | Meaning |
|-----|---------|
| `d` | `"widx:" + sha256(normalized_url)[0:32]` — URL identity, identical across all indexers |
| `u` | Canonical URL (normalized per SIP-01 §7) |
| `x` | Content hash: `sha256(title + "\n" + description)` |
| `v` | Schema version `"1"` |
| `l` | ISO 639-1 language code |
| `source` | `"indexstr/v2"` (v1 nodes: `"indexstr/1"`) |
| `network` | Extension registry (§9.2) — always `clearnet` for a browser crawler |
| `type` | Extension registry — `repository` for GitHub/GitLab, else `page` |
| `alt` | Human-readable description (the `alt` convention, spec §12.3) |

Full schema documentation: [NIP.md](NIP.md) · Canonical spec: [SIP-01 v1.2](https://github.com/NostrDanish/SIP-01/blob/main/public/spec/SIP-01.md)

### Relay Pool

Observations and heartbeats are pushed to every relay in the publish set — SIP-01 index relays first, then NIP-50 search relays, then broad-propagation relays:

- `wss://relay-na1.metanomalist.com/`
- `wss://test-sip-relay.sip-01test.workers.dev/` (SIP-01)
- `wss://sip-relay-2.sip-booster-relay.workers.dev/` (SIP-01)
- `wss://sip-relay-3.uncaged-sip.workers.dev/` (SIP-01)
- `wss://sip-relay-4.sip-relay-4.workers.dev/` (SIP-01)
- `wss://relay.nostr.band/` (NIP-50 search)
- `wss://relay.ditto.pub/` (NIP-50 search)
- `wss://relay.noswhere.com/` (NIP-50 search)
- `wss://jskitty.cat/nostr`
- `wss://relay.primal.net/`
- `wss://relay.damus.io/`
- `wss://nostr.hifish.org/`
- `ws://acuy3mjnv26tkyaaucndlxmg2ocntz4rtebhavk57vgruozm42iaznqd.onion/` (Tor only — reachable from Tor Browser; clearnet browsers auto-skip it after repeated failures)

(`wss://search.nos.today/` is read-only — "blocked: writes disabled" — so it is read from but never published to.)

**The pool is yours.** Settings → Relay pool: add custom relays (persisted on this device, applied on the next publish cycle), probe any relay's live capabilities (NIP-11: latency, NIP-50, SIP-01 `uncaged_index`), or auto-discover new ones — public NIP-66 monitor data is scanned for relays advertising NIP-50 or kind 39697, then each candidate is verified against its own NIP-11 document before being offered. Built-ins can't be removed (they keep every node functional). Per-relay health is tracked during publishing; a relay that fails 8+ times with zero successes is skipped for the rest of the session.

---

## Federation: One Index, Many Crawlers

Indexstr is **one more independent indexer** in the SIP-01 ecosystem:

```
Indexstr (browser indexer w/ curated collections)
    │
    ▼ kind 39697, signed by device indexer key
Nostr Relays
    │
    ├──→ 0xSearchstr (search engine) reads it
    ├──→ 0xPresearchstr (search engine) reads it
    ├──→ UNCAGED (search engine template) reads it
    └──→ Any SIP-01 client reads it
```

Multiple crawlers observing the same URL produce events with the **same `d` tag** and different pubkeys — search nodes group by `d` and count distinct authors ("7 independent indexers saw this page").

---

## Browser Limitations

Indexstr is honest about what a browser can and cannot do:

- **CORS** — A browser cannot read cross-origin responses unless the site sends CORS headers, and most don't. Indexstr tries a direct fetch first, then falls back to a **CORS proxy** so real websites can actually be crawled. The trade-off is honest: when the proxy is used, the proxy operator sees which URL was fetched (never a search query, never a user identity). The dashboard shows the direct/proxy split per session.
- **JavaScript rendering** — Indexstr parses static HTML. Single-page apps that require JavaScript rendering won't have their full content extracted.
- **Background execution** — Mobile browsers may throttle or kill background tabs. The crawler is most effective when the tab is active.
- **Rate limits** — Per-domain rate limiting is built-in. This is respectful by design, and why bundled collections are curated rather than endless.

For unrestricted crawling, run a desktop/CLI SIP-01 crawler alongside Indexstr.

---

## Tech Stack

- **React 19** + TypeScript + Vite
- **TailwindCSS 4** + shadcn/ui
- **Nostrify** — Nostr relay pool
- **nostr-tools** — Event signing (`finalizeEvent`)
- **idb** — IndexedDB wrapper for the crawl queue + collection cache
- **Custom SQLite reader** (`src/crawler/sqlite.ts`) — parses collection databases in-browser, no WASM
- **TanStack Query** — Data fetching + caching
- **PWA** — Service worker, manifest, installable

---

## Project Structure

```
src/
├── crawler/
│   ├── engine.ts           ← Node orchestrator (crawl loop, heartbeats, outbox, intake)
│   ├── queue.ts            ← IndexedDB queue + shard index + observation outbox
│   ├── sharding.ts         ← Deterministic crawl-space sharding (FNV-1a, 256 shards)
│   ├── capabilities.ts     ← Coarse, privacy-minimal node capability profile
│   ├── heartbeat.ts        ← Kind 16919 node heartbeat (build/sign/parse)
│   ├── enrich.ts           ← Enrichment: topic derivation + doc-type classification
│   ├── freshness.ts        ← Adaptive recrawl scheduling (change-driven intervals)
│   ├── traps.ts            ← Crawl-trap heuristics + per-domain intake guards
│   ├── providers.ts        ← SeedProvider abstraction (modular discovery sources)
│   ├── collections.ts      ← Bundled collection registry + loader/cache
│   ├── sqlite.ts           ← Minimal read-only SQLite parser (b-tree, records, overflow)
│   ├── fetcher.ts          ← HTTP fetcher (CORS, timeout, size limits)
│   ├── parser.ts           ← HTML parser (title, description, text, links, language)
│   ├── hasher.ts           ← SHA-256 content hashing for local dedup
│   ├── webIndex.ts         ← SIP-01: URL normalization, event build/parse (byte-compatible)
│   ├── indexerIdentity.ts  ← Per-device anonymous indexer keypair
│   ├── publisher.ts        ← Kind 39697 signing/publishing + relay health
│   ├── relays.ts           ← Ecosystem relay pool configuration
│   ├── robots.ts           ← robots.txt parser with caching
│   ├── limits.ts           ← Per-domain rate limiting
│   └── types.ts            ← TypeScript interfaces
├── components/
│   └── crawler/
│       ├── CrawlerDashboard.tsx   ← Node UI (toggle, shard, stats, relay health, tabs)
│       ├── CollectionsPanel.tsx   ← Bundled collection cards + load/progress
│       └── IndexstrLogo.tsx       ← Brand mark
├── hooks/
│   ├── useCrawler.ts       ← React hook wiring engine to Nostr
│   └── useNetworkNodes.ts  ← Active-indexer estimate from kind 16919 heartbeats
├── pages/
│   └── Index.tsx           ← Landing page + dashboard
└── NIP.md                  ← Protocol documentation (39697 + 16919 + sharding)

public/
└── collections/            ← Bundled SQLite URL collections (loaded on demand)
```

## Roadmap

Live today: deterministic sharding, node heartbeats, offline outbox, enrichment (topics + doc types), network discovery intake, freshness scheduling, trap guards.

Next phases, in order of value:

1. **Reputation derivation** — search-side scoring from signed observations (independent count, freshness, agreement). Heartbeats stay self-reported health metadata, never a trust input.
2. **Sitemap-first discovery** — a `SeedProvider` that expands `robots.txt` → `sitemap.xml` → URL sets for cheap structured discovery.
3. **Community seed lists over Nostr** — a `SeedProvider` that loads curated URL lists published as Nostr events, so the community extends discovery without shipping app updates.
4. **Headless core extraction** — the `src/crawler` module is already UI-free; packaging it for CLI/VPS nodes (with a real fetch stack instead of the CORS proxy) multiplies network capacity.
5. **Domain profiles** — aggregate per-domain metadata (topics, languages, feed presence) from this node's own observation history.
6. **Shard leases** — if sparse-network coverage proves patchy, heartbeat-mediated shard claiming can sharpen the current statistical assignment. Preferential sharding already tolerates node churn without it.

---

## Ecosystem

| Project | Role | URL |
|---------|------|-----|
| **Indexstr** (this) | Browser indexer w/ collections → SIP-01 publisher | [github.com/NostrDanish/indexstr](https://github.com/NostrDanish/indexstr) |
| [SIP-01](https://github.com/NostrDanish/SIP-01) | Canonical spec + explorer (consumes our kind 16919 heartbeats) | — |
| [Crawlstr](https://github.com/NostrDanish/Crwalstr) | The original browser crawler | [crawlstr.shakespeare.wtf](https://crawlstr.shakespeare.wtf) |
| [0xSearchstr](https://github.com/NostrDanish/0xSearchstr) | Search engine → SIP-01 reader | [0xsearchstr.shakespeare.wtf](https://0xsearchstr.shakespeare.wtf) |
| [0xPresearchstr](https://github.com/NostrDanish/0xPresearchstr) | Community fork with keyword staking | [presearchstr.shakespeare.wtf](https://presearchstr.shakespeare.wtf) |
| [UNCAGED-ENGINE](https://github.com/NostrDanish/UNCAGED-ENGINE) | Minimal search engine template | [uncaged.shakespeare.wtf](https://uncaged.shakespeare.wtf) |

---

## Privacy, Honestly

- **No login required** to index. No account. No tracking.
- Observations are signed by a **per-device anonymous keypair**, never your personal Nostr identity.
- Events contain **page metadata only** — never search queries, never browsing history.
- Your crawl history and the collection cache stay in your browser (IndexedDB). Clearing browser data removes them.
- Relay operators see the observation event and your IP address — that's how Nostr works. Key separation is guaranteed; network anonymity is not.
- Use a VPN or Tor — we recommend [NymVPN](https://nym.com).

**Support us:** [https://nym.com/pricing?ref=aYPKAFmGpJi](https://nym.com/pricing?ref=aYPKAFmGpJi)

---

## License

MIT

---

*Vibed with [Shakespeare](https://shakespeare.diy)*
