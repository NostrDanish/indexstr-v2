/**
 * relayprobe.ts — NIP-11 relay capability probing (OPTIONAL module;
 * UI-triggered in both apps).
 *
 * A relay's NIP-11 document tells us what it supports before we commit to
 * it: `supported_nips` (NIP-50 = search) and, on SIP-01-aware relays, the
 * `uncaged_index` block (spec §15) describing the indexed document kinds
 * and available operators.
 *
 * The probe is a plain HTTPS GET with an `Accept: application/nostr+json`
 * header THROUGH net.ts (the guardedFetch choke point) — relay URLs come
 * from attacker-publishable kind 30166 NIP-66 events, so a "relay" at
 * ws://169.254.169.254 must cause ZERO requests, direct or proxied
 * (audit finding #2).
 */

import type { NostrEvent } from '@nostrify/nostrify';
import type { Net } from '../net';
import { isPubliclyFetchable } from '../guard';

export interface RelayCapabilities {
  url: string;
  /** True when the relay answered a NIP-11 document at all. */
  online: boolean;
  /** NIP-50 search support. */
  nip50: boolean;
  /** SIP-01-aware (publishes the uncaged_index NIP-11 block). */
  sip01: boolean;
  /** Relay-reported name, when present. */
  name?: string;
  /** Round-trip latency of the probe. */
  latencyMs: number;
  /** The relay's supported NIP list, when reported. */
  supportedNips?: number[];
  /** The uncaged_index block verbatim, when present. */
  sip01Scope?: Record<string, unknown>;
}

/** Normalize a relay URL: default to wss://, canonical trailing slash. */
export function normalizeRelayUrl(input: string): string | null {
  let url = input.trim();
  if (!url) return null;
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    url = `wss://${url}`;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return null;
    const path = parsed.pathname === '/' ? '/' : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return null;
  }
}

/**
 * Extract relay URLs that advertise a given NIP from kind 30166 events.
 * SSRF pre-filter (audit finding #2): kind 30166 events are
 * attacker-publishable, so drop relays pointing at private/loopback/
 * link-local hosts before they ever reach the probe path. The probe itself
 * is guarded too — this just keeps junk out of the candidate set.
 */
export function extractRelaysWithNip(events: NostrEvent[], nip: number): string[] {
  const nipStr = String(nip);
  const urls = new Set<string>();

  for (const event of events) {
    const supported = event.tags.some(([n, v]) => n === 'N' && v === nipStr);
    if (!supported) continue;

    const d = event.tags.find(([n]) => n === 'd')?.[1];
    if (!d) continue;

    const normalized = normalizeRelayUrl(d);
    if (!normalized || !normalized.startsWith('wss://')) continue;
    if (!isPubliclyFetchable(normalized.replace(/^wss:/, 'https:'))) continue;
    urls.add(normalized);
  }

  return [...urls];
}

export class RelayProbe {
  constructor(
    private readonly net: Net,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Probe a relay's NIP-11 document and report what it supports. */
  async probeRelay(url: string): Promise<RelayCapabilities> {
    // NIP-11: the document lives at the relay's HTTP(S) endpoint.
    const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');

    const startedAt = this.clock();
    // The guard runs inside guardedFetch — a private target short-circuits
    // to a permanent 'ssrf' refusal with ZERO requests issued.
    const outcome = await this.net.guardedFetchText(httpUrl, {
      accept: 'application/nostr+json',
      timeoutMs: 8000,
      // A clearnet proxy can't reach Tor — don't proxy plain-http targets.
      allowProxy: !httpUrl.startsWith('http:'),
    });

    if (!outcome.ok) {
      return { url, online: false, nip50: false, sip01: false, latencyMs: 0 };
    }

    let json: unknown;
    try {
      json = JSON.parse(outcome.body);
    } catch {
      return { url, online: false, nip50: false, sip01: false, latencyMs: 0 };
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return { url, online: false, nip50: false, sip01: false, latencyMs: 0 };
    }
    const doc = json as Record<string, unknown>;
    const supportedNips = Array.isArray(doc.supported_nips)
      ? doc.supported_nips.filter((n): n is number => typeof n === 'number')
      : undefined;
    const sip01Scope =
      doc.uncaged_index && typeof doc.uncaged_index === 'object' && !Array.isArray(doc.uncaged_index)
        ? (doc.uncaged_index as Record<string, unknown>)
        : undefined;

    return {
      url,
      online: true,
      nip50: supportedNips?.includes(50) ?? false,
      sip01: sip01Scope?.sip01 === true,
      name: typeof doc.name === 'string' ? doc.name.slice(0, 80) : undefined,
      latencyMs: this.clock() - startedAt,
      supportedNips,
      sip01Scope,
    };
  }

  /** Probe several relays in parallel (each with its own timeout). */
  async probeRelays(urls: string[]): Promise<RelayCapabilities[]> {
    return Promise.all(urls.map((url) => this.probeRelay(url)));
  }
}
