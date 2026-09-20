import type { RelayMetadata } from '@/contexts/AppContext';

/**
 * App default relays. Used as the initial `relayMetadata` for new users and as
 * a fallback when the user has no NIP-65 relay list configured (e.g. during
 * nostrconnect handshakes before any user relays have been loaded).
 */
export const APP_RELAYS: RelayMetadata = {
  relays: [
    { url: 'wss://relay-na1.metanomalist.com/', read: true, write: true },
    { url: 'wss://relay.ditto.pub/', read: true, write: true },
    { url: 'wss://relay.dreamith.to/', read: true, write: true },
    { url: 'wss://jskitty.cat/nostr', read: true, write: true },
    { url: 'wss://search.nos.today/', read: true, write: false },
    { url: 'wss://relay.primal.net/', read: false, write: true },
    { url: 'wss://nos.lol/', read: false, write: true },
    { url: 'wss://nostr.hifish.org/', read: true, write: true },
    // Tor-only relay — reachable from Tor Browser (where .onion is a secure
    // context, so plain ws:// is acceptable); clearnet browsers skip it.
    { url: 'ws://acuy3mjnv26tkyaaucndlxmg2ocntz4rtebhavk57vgruozm42iaznqd.onion/', read: true, write: true },
  ],
  updatedAt: 0,
};
