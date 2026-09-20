# @sip01/crawler-core

The ONE deep module both crawler apps (crawlstr, indexstr) share. Everything
that used to be ~20 shallow, forked, drifting modules in
`apps/*/src/crawler/` lives behind a single entry point:

```ts
import { createCrawler } from '@sip01/crawler-core';

const node = createCrawler({
  dbName: 'crawlstr-crawler',
  source: 'crawlstr/v2',
  signer,                       // host-injected: template → signed event
  transports: { publish },      // host-injected relay seam
  relays: { publish: ['wss://relay.ditto.pub', 'wss://relay.nos.lol'] },
  modules: { discovery: { feeds: true, sitemaps: true } },
});

await node.start();
await node.seed(['https://example.com/']);
```

## The deep-module boundary

`package.json` `exports` exposes **only** `./src/index.ts` —
`createCrawler(config): CrawlerNode` plus types. Queue scheduling, robots
caching, SSRF enforcement, retry policy, worker pooling, outbox flushing are
all internal. Apps cannot import `@sip01/crawler-core/internal/*`, so the P0
ordering bug class (robots fetched before the page's SSRF check; a private
URL entering the queue) is **unrepresentable from the outside**, not just
patched.

Beyond the lifecycle/crawl methods, `CrawlerNode` also owns the dashboard
read/maintenance surface so apps never open the crawler database directly:

- `persistedStats()` — queue/index/outbox counts readable before `start()`.
- `recentCrawls(limit, opts?)` — History tab rows (fetched-only default).
- `clearQueue()` / `clearAll()` — the Clear Queue / full-reset buttons.
- `networkHeartbeats()` + the exported heartbeat readers (`parseHeartbeat`,
  `dedupeHeartbeats`, `isNodeLive`, `HEARTBEAT_KIND`, `HEARTBEAT_TTL_S`) —
  the kind-16919 network view, powered by `transports.heartbeatQuery`.
- `seed(urls, { followLinks: false })` — curated collections are indexed
  exactly as listed instead of self-expanding outward.

### Host-injected seams (no React, no app imports, no direct nostr pool)

| Seam | Where | Default |
|---|---|---|
| `signer` — NostrEvent template → signed event (dedicated indexer identity, spec §14; never the user's key) | `config.signer` | `@sip01/protocol` device indexer identity |
| relay publish/query | `config.transports.publish` / `.query` / `.subscribe` / `.heartbeatQuery` | — (required: publish) |
| storage adapter | `config.storage` (`CrawlerStorage`) | IndexedDB under `config.dbName` |
| clock | `config.clock` | `Date.now` |
| fetch transport | `config.transports.fetch` | `globalThis.fetch`, used ONLY via the choke point |

### The choke point

`src/internal/net.ts` (`guardedFetch`) is the only function in core that
calls `fetch`. Every request — page, robots.txt, feed, sitemap, NIP-11
probe, direct or proxied — passes `guard.ts`'s `assertPublicUrl` first
(fail closed; union of both v1 guards + IPv6 NAT64/6to4/Teredo/mapped/
compatible unfolding + decimal/octal/hex IPv4 + `.home.arpa`/`.corp`), is
re-checked after redirects on the direct path, is stream-capped, and is
byte-metered. Admission (`engine.admit()`) runs normalize → guard → traps →
dedup → queue-cap for EVERY enqueue source (seeds, links, feeds, sitemaps,
network intake).

### Optional modules (config-flagged)

| Module | crawlstr | indexstr |
|---|---|---|
| `traps` (crawl-trap heuristics) | on (default) | on (default) |
| `discovery` (RSS/Atom + sitemaps) | on | opt-in |
| `intake` (kind 39697 network intake + Sybil/domain guards) | off (default) | on |
| `enrich` (topic lexicon + doc-type) | off (default) | on |
| `sharding` (home-shard-preferential scheduling) | off | on |
| `heartbeat` (kind 16919 side-channel) | off | on |
| `relayprobe` (NIP-11 probe via choke point) | UI-triggered (`node.probeRelay`) | same |

## Plugin-contract alignment (upstream endgame)

This package is designed to be upstreamed into `sip-01-core` as a
producer-side `src/crawler/` layer (see `sip01-plugin-integration.md`). The
host-injection points above mirror the proposed `CrawlerContext` surface —
`publish`/`query` (relay seams), `clock`, storage, signer — so a future
`CrawlerPlugin` wrapper is a thin adapter over `CrawlerNode`, not a rewrite.

## Wire format

All SIP-01 event construction comes from `@sip01/protocol` (verbatim copy of
the reference `sip-01-core/src/protocol/*`). crawler-core never builds tags
itself. The crawler layer additionally clamps page-claimed `published ≤ 0`
before the builder (finding C-1; defense in depth — the shared builder
clamps too).

## Development

```sh
npm install
npx vitest run     # test gate (jsdom + fake-indexeddb)
npx tsc --noEmit   # type gate (strict)
```

Note: `@sip01/protocol` is a `file:` devDependency on the sibling workspace
package. Until that package ships a built `dist/`, tsconfig `paths` and the
vitest alias resolve the import to `test/shims/sip01-protocol.ts`, which
re-exports the sibling's REAL source (never a vendored copy). Delete the
shim once `@sip01/protocol` builds its own barrel.

## Known limitations (documented, not hidden)

- Proxied fetches resolve redirects and DNS server-side; a public page
  redirecting to a private target is followed by the proxy unchecked, and
  DNS rebinding is undefendable from a browser. The pre-send guard is the
  control for that path.
- P1 runs the crawl loop serially; `workerCount`/`parallelism` are accepted
  config so P3 can add worker parallelism WITHOUT an API change.
- P2 backlog: crawled-store eviction (250k cap, `by-crawledAt` index),
  negative-cache 7-day TTL sweep, IDB-persisted intake guards, publish lane
  fully off the critical path.
