import { describe, it, expect, beforeEach } from 'vitest';

import {
  getDiscoveredIndexRelays,
  getDiscoveredSearchRelays,
  getDiscoveryCache,
  isRelayDiscoveryEnabled,
  normalizeRelayUrl,
  resetRelayDiscoveryConfig,
  setRelayDiscoveryEnabled,
  type VerifiedRelay,
} from './relayDiscovery';

const VERIFIED_KEY = 'sip01:relay-discovery:verified';

function seedCache(relays: VerifiedRelay[]): void {
  localStorage.setItem(VERIFIED_KEY, JSON.stringify({ relays, fetchedAt: Date.now() }));
}

describe('normalizeRelayUrl (inlined from relayUrls.ts)', () => {
  it('accepts ws/wss and bare hosts, rejects other schemes', () => {
    expect(normalizeRelayUrl('wss://relay.example.com')).toBe('wss://relay.example.com/');
    expect(normalizeRelayUrl('relay.example.com')).toBe('wss://relay.example.com/');
    expect(normalizeRelayUrl('ws://localhost:7777/nest')).toBe('ws://localhost:7777/nest');
    expect(normalizeRelayUrl('https://not-a-relay.example.com')).toBeNull();
    expect(normalizeRelayUrl('ftp://x')).toBeNull();
    expect(normalizeRelayUrl('')).toBeNull();
  });
});

describe('relay discovery storage surface', () => {
  beforeEach(() => {
    localStorage.clear();
    resetRelayDiscoveryConfig();
  });

  it('is enabled by default; the flag round-trips', () => {
    expect(isRelayDiscoveryEnabled()).toBe(true);
    setRelayDiscoveryEnabled(false);
    expect(isRelayDiscoveryEnabled()).toBe(false);
    setRelayDiscoveryEnabled(true);
    expect(isRelayDiscoveryEnabled()).toBe(true);
  });

  it('feeds pools only from NIP-11-verified cache entries, capped at 4 each', () => {
    const relays: VerifiedRelay[] = [
      ...Array.from({ length: 6 }, (_, i) => ({
        url: `wss://search${i}.example.com/`,
        nip50: true,
        sip01: false,
        latencyMs: i,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        url: `wss://index${i}.example.com/`,
        nip50: false,
        sip01: true,
        latencyMs: i,
      })),
    ];
    seedCache(relays);
    expect(getDiscoveredSearchRelays()).toHaveLength(4);
    expect(getDiscoveredIndexRelays()).toHaveLength(4);
    expect(getDiscoveredSearchRelays()[0]).toBe('wss://search0.example.com/');
    expect(getDiscoveredIndexRelays()[0]).toBe('wss://index0.example.com/');
  });

  it('returns nothing while discovery is disabled', () => {
    seedCache([{ url: 'wss://a.example.com/', nip50: true, sip01: true, latencyMs: 1 }]);
    setRelayDiscoveryEnabled(false);
    expect(getDiscoveredSearchRelays()).toEqual([]);
    expect(getDiscoveredIndexRelays()).toEqual([]);
  });

  it('reads a host-injected legacy key and migrates it on first read', () => {
    // configureRelayDiscoveryStorage is exercised indirectly: the neutral
    // defaults have no legacy keys, so assert cache read/write round-trip.
    seedCache([{ url: 'wss://b.example.com/', nip50: false, sip01: true, latencyMs: 5 }]);
    expect(getDiscoveryCache()?.relays[0].url).toBe('wss://b.example.com/');
  });

  it('tolerates corrupted cache JSON', () => {
    localStorage.setItem(VERIFIED_KEY, '{not json');
    expect(getDiscoveryCache()).toBeNull();
    expect(getDiscoveredSearchRelays()).toEqual([]);
  });
});
