# @sip01/protocol

The SIP-01 (Search Index Protocol) **wire-format reference** for the
crawlstr / indexstr v2 monorepo. One addressable Nostr event (kind 39697)
per indexed web document; every crawler and every search engine in the
ecosystem must produce byte-identical `d`/`x` identities for the same page,
or deduplication breaks and the network forks.

- Canonical spec: `SIP-01` v1.2 (`github.com/NostrDanish/SIP-01`).
- Source of truth: vendored **byte-verbatim** from `sip-01-core@live`
  (`github.com/NostrDanish/sip-01-core`, cloned 2026-09-20)
  `src/protocol/{webIndex,indexerIdentity}.ts` + `src/lib/relayDiscovery.ts`.
- This package changes only when the spec changes. The single documented
  divergence is listed below.

## API

```ts
import {
  // constants
  WEB_INDEX_KIND,            // 39697
  WEB_INDEX_SCHEMA_VERSION,  // '1'
  WEB_INDEX_D_PREFIX,        // 'widx:'
  TOPIC_RE, EXTENSION_VALUE_RE, MIME_RE,
  // identities / hashing
  normalizeIndexUrl,         // spec §7 — byte-compatibility is rule zero
  documentId,                // spec §3: widx: + sha256(normalized)[0:32]
  contentHash,               // spec §8: sha256(title + '\n' + description)
  // build / parse / verify
  buildIndexEvent,           // unsigned kind 39697 template (null on unusable input)
  parseIndexEvent,           // lenient-structural reader (null on malformed)
  verifyObservation,         // spec §18 step 2: d↔u and x↔content integrity
  // indexer identity (spec §14) — dedicated, pseudonymous, replaceable
  getIndexerIdentity, regenerateIndexerIdentity,
  exportIndexerNsec, getIndexerPubkey, getIndexerSecretKey,
  // relay auto-discovery (NIP-66 candidates + NIP-11 verification)
  refreshDiscoveredRelays, getDiscoveredSearchRelays, getDiscoveredIndexRelays,
  getDiscoveryCache, isRelayDiscoveryEnabled, setRelayDiscoveryEnabled,
  configureRelayDiscoveryStorage, resetRelayDiscoveryConfig, normalizeRelayUrl,
  // types
  type IndexObservationInput, type UnsignedIndexEvent, type IndexObservation,
  type IndexerIdentity, type VerifiedRelay, type RelayDiscoveryConfig,
} from '@sip01/protocol';
```

The strict relay-side validator used by the conformance suite is exported
for tests/tooling from `@sip01/protocol/conformance` (Node-only, uses
`node:crypto`): `validateWebDocument`, `relayNormalizeIndexUrl`,
`relayWebDocumentDTag`, `relayWebDocumentContentHash`.

## The one divergence from upstream (upstream PR candidate)

**`published > 0` clamp in `buildIndexEvent`.** Upstream
`sip-01-core@live src/protocol/webIndex.ts:204` passes any *truthy*
`published` through `Math.floor` — a page claiming a pre-1970 date yields a
**negative** tag value, and every UNCAGED-family relay then rejects the
whole event (`published` must match `^\d{1,16}$`; audit finding C-1,
compliance checklist A15). This package emits the tag only for finite,
strictly positive unix-second timestamps:

```ts
...(typeof input.published === 'number' && Number.isFinite(input.published) && input.published > 0
  ? [['published', String(Math.floor(input.published))] as string[]]
  : []),
```

The clamp can only *remove* tags relays would reject anyway, so it cannot
cause a wire fork. It is pinned by the golden corpus (zero/negative cases)
and checklist test A15, and should be PR'd upstream.

## Conformance suite

`src/conformance/` makes the audit checklist executable:

- `checklist.test.ts` — the 30-item SIP-01 compliance checklist
  (audit `sip01-contract.md` §6) as named tests (`A1`–`A19` event
  construction, `B20`–`B27` identity/timing/publishing, `C28`–`C30`
  heartbeat boundaries). Test names carry the checklist numbers.
- `golden-corpus.json` + `golden.test.ts` — **50 diverse events** (tracking
  params, unicode paths/queries/titles, ports, all six extension tags,
  clamped `published`, truncation boundaries) with pinned byte-exact `u`,
  `d`, `x`, full tag lists, and serialized content. A diff here without a
  spec revision is a network fork. Regenerate only intentionally:
  `npm run build && node scripts/generate-golden-corpus.mjs`.
- `relayValidator.ts` + `relay-parity.test.ts` — verbatim port of the
  UNCAGED Index Relay's `validateWebDocument` regex/validation table; all
  50 golden events must pass, 28 deliberately-invalid events must fail with
  the expected reason classes.

The upstream spec §13 test vectors are pinned in `src/webIndex.test.ts`
(copied with the implementation).

## Development

```bash
npm install        # inside this package only (never the workspace root)
npx vitest run     # full suite: upstream + checklist + golden + relay parity
npx tsc --noEmit   # strict typecheck
npm run build      # emit dist/ (ESM + .d.ts)
```

Environment: Node ≥ 20 (`crypto.subtle`, `AbortSignal.any`); the identity
and discovery modules use `localStorage` when available and degrade to
session-only behavior without it.
