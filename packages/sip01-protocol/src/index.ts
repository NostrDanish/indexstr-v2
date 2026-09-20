/**
 * @sip01/protocol — the SIP-01 (Search Index Protocol) wire contract.
 *
 * Public surface mirrors the `src/protocol/` section of sip-01-core's
 * PACKAGE_BOUNDARIES.md (protocol-critical: changes only with a spec
 * revision), plus the relay auto-discovery utilities. This package IS the
 * wire-format reference for the crawlstr/indexstr apps — divergence from
 * upstream sip-01-core means a network fork. The single documented
 * divergence is the `published > 0` clamp (see webIndex.ts and README.md).
 */

/* ---- webIndex.ts: kind 39697 build / parse / verify (spec v1.2) ---- */
export {
  WEB_INDEX_KIND,
  WEB_INDEX_SCHEMA_VERSION,
  WEB_INDEX_D_PREFIX,
  TOPIC_RE,
  EXTENSION_VALUE_RE,
  MIME_RE,
  normalizeIndexUrl,
  documentId,
  contentHash,
  buildIndexEvent,
  parseIndexEvent,
  verifyObservation,
} from './webIndex';
export type {
  IndexObservationInput,
  UnsignedIndexEvent,
  IndexObservation,
} from './webIndex';

/* ---- indexerIdentity.ts: anonymous indexing identity (spec §14) ---- */
export {
  getIndexerIdentity,
  regenerateIndexerIdentity,
  exportIndexerNsec,
  getIndexerPubkey,
  getIndexerSecretKey,
} from './indexerIdentity';
export type { IndexerIdentity } from './indexerIdentity';

/* ---- relayDiscovery.ts: NIP-66/NIP-11 relay auto-discovery ---- */
export {
  refreshDiscoveredRelays,
  getDiscoveredSearchRelays,
  getDiscoveredIndexRelays,
  getDiscoveryCache,
  isRelayDiscoveryEnabled,
  setRelayDiscoveryEnabled,
  configureRelayDiscoveryStorage,
  getRelayDiscoveryConfig,
  resetRelayDiscoveryConfig,
  normalizeRelayUrl,
} from './relayDiscovery';
export type {
  VerifiedRelay,
  RelayDiscoveryStorageKeys,
  RelayDiscoveryConfig,
} from './relayDiscovery';
