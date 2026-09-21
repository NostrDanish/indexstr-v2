/**
 * relayprobe.test.ts — port of crawlstr relayProbe.test.ts (audit finding
 * #2), adapted to the core's RelayProbe class. Relay URLs come from kind
 * 30166 NIP-66 events — attacker-publishable network data. fetch is mocked;
 * the core assertion is that non-public targets cause ZERO requests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { Net } from '../net';
import { RelayProbe, extractRelaysWithNip } from './relayprobe';

function nip66Event(relayDTag: string): NostrEvent {
  return {
    kind: 30166,
    pubkey: 'a'.repeat(64),
    id: 'b'.repeat(64),
    sig: 'c'.repeat(128),
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['d', relayDTag],
      ['N', '50'],
    ],
  };
}

const makeProbe = () => new RelayProbe(new Net({ proxyTemplate: 'https://proxy.example/?url={href}' }));

describe('relayProbe SSRF guard (audit finding #2)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ supported_nips: [1, 50] }), { status: 200 })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses a NIP-11 probe to 169.254.169.254 (cloud metadata)', async () => {
    const caps = await makeProbe().probeRelay('ws://169.254.169.254');
    expect(caps.online).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses loopback, RFC1918 and localhost probes', async () => {
    const probe = makeProbe();
    const results = await probe.probeRelays([
      'wss://127.0.0.1:7777',
      'ws://10.0.0.8',
      'wss://192.168.0.1',
      'wss://172.16.5.5',
      'ws://localhost:4869',
      'wss://[::1]',
    ]);
    expect(results.every((r) => !r.online)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('probes a normal public relay and reports its capabilities', async () => {
    const caps = await makeProbe().probeRelay('wss://relay-public-example.com');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('https://relay-public-example.com');
    expect(caps.online).toBe(true);
    expect(caps.nip50).toBe(true);
  });

  it('drops private-host relays at discovery time (kind 30166 intake)', () => {
    const events = [
      nip66Event('wss://169.254.169.254'),
      nip66Event('ws://127.0.0.1:7777'),
      nip66Event('wss://10.1.2.3'),
      nip66Event('wss://relay-good-example.com'),
    ];
    const candidates = extractRelaysWithNip(events, 50);
    expect(candidates).toEqual(['wss://relay-good-example.com/']);
  });
});
