# Indexstr v2

> **Distributed browser indexing network node for SIP-01.** Indexstr v2 runs the
> full deep-crawler stack in your browser — SSRF-guarded fetching, IndexedDB
> crawl queue/outbox, politeness scheduler — plus curated URL collections, and
> publishes signed **kind 39697 web-index observations** to Nostr relays tagged
> **`source=indexstr/v2`**.

This is a self-contained v2 app repo, sliced from the web-crawler monorepo.
Everything needed to build and run Indexstr v2 is in this tree (with one
exception — see **MISSING BINARIES** below).

## Layout

```
├── packages/sip01-protocol/   # @sip01/protocol — SIP-01 v1.2 wire format (kind 39697 build/parse/verify)
├── packages/crawler-core/     # @sip01/crawler-core — shared deep crawler (SSRF guard, queue, scheduler, publishing lane)
└── apps/indexstr/             # the Indexstr v2 web app (Vite + React 19 + Tailwind 4)
```

## Quickstart

Requires Node.js ≥ 20 and pnpm 12.

```bash
pnpm install        # no frozen lockfile is shipped; resolves fresh
pnpm build          # builds @sip01/protocol, then the app (pnpm -r build)
pnpm test           # typecheck + lint + vitest + production build
pnpm typecheck      # tsc --noEmit across the workspace
```

Dev server:

```bash
pnpm --filter indexstr dev    # http://localhost:8080
```

## Source tag

All SIP-01 observations published by this app carry `source=indexstr/v2`
(`apps/indexstr/src/hooks/useCrawler.ts` → `CRAWLER_SOURCE`), distinguishing
v2 Indexstr nodes from v1 and from Crawlstr (`crawlstr/v2`) nodes.

## MISSING BINARIES

Collections DBs are not in this repo (API size limits). Copy apps/indexstr/public/collections/*.db from NostrDanish/indexstr (v1) — they are unchanged — or from the v2 release archive.

Missing files (to be placed under `apps/indexstr/public/collections/`):

- `top.db` (~25 MB)
- `awesomelists.db` (~20 MB)
- `feeds.db` (~18 MB)
- `music.db` (~10 MB)
- `books.db` (~1.3 MB)
- `movies.db` (~1 MB)
- `memes.db` (~1 MB)
- `videogames.db` (~0.8 MB)

Also excluded for size: `apps/indexstr/public/brand/logo.png` (375 KB) — copy
from v1 as well if the push did not include it (check the repo tree first).

### What happens without the DBs? (verified behavior)

`apps/indexstr/src/crawler/sqlite.ts` never fetches anything — it is a
read-only SQLite file-format parser. Fetching lives in
`apps/indexstr/src/crawler/collections.ts` (`loadCollectionEntries` →
`fetchDatabase`), which tries, in order:

1. `/collections/<id>.db` — the same-origin static file (missing here),
2. `https://blossom.primal.net/<sha256>` — the collection's Blob hash on a
   public Blossom server,
3. the same Blossom URL through the CORS proxy
   (`https://proxy.shakespeare.diy/?url=…`).

So at runtime the app **may still load collections from Blossom even without
the local files**. If all three sources fail (e.g. 404 from the missing local
file and no reachable Blossom copy), `loadCollectionEntries` throws, the
Collections panel catches it and shows a per-collection error state (e.g.
"HTTP 404 for top.db"), and the panel is otherwise empty — **crawling,
queueing, and SIP-01 publishing are completely unaffected**.

## Notes

- No lockfile is included (repository size limits) — `pnpm install` resolves
  dependencies fresh; do not use `--frozen-lockfile`.
- `packages/*` are workspace dependencies of the app (`workspace:*`); pnpm
  links them automatically at install time. The root `postinstall` builds
  `@sip01/protocol` first, since its published entry points at `dist/`.
- Production homepage: https://indexstr.shakespeare.wtf

## License

MIT — see [LICENSE](LICENSE).
