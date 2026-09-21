/**
 * publisher.ts — the publish lane: build (via @sip01/protocol) → sign
 * (host-injected signer) → fan out to the publish relay set with a
 * per-relay health gate → zero-ack events land in the IDB outbox.
 *
 * The crawl loop NEVER blocks on relay fan-out beyond this call: a hanging
 * relay can't stall the pipeline, and a dead network never costs an
 * observation (local-first — the outbox flushes on start / `online` /
 * timer / next success).
 *
 * Wire behavior is NOT this module's job: buildIndexEvent (frozen protocol
 * layer) does normalization, truncation, hashing. The one clamp here —
 * dropping non-positive `published` claims before the builder — is the
 * crawler-layer fix for SIP-01 finding C-1 (relay regex ^\d{1,16}$).
 *
 * stats.published counts only relay-ACKED events (acked-only accounting).
 */

import type { NostrEvent } from '@nostrify/nostrify';
import {
  buildIndexEvent,
  normalizeIndexUrl,
  type IndexObservationInput,
} from '@sip01/protocol';

import type { CrawlerStorage } from './storage';

export interface RelayHealth {
  ok: number;
  fail: number;
  /** unix ms of last accepted event; 0 = never */
  lastOk: number;
  /** last error message, if the last attempt failed */
  lastError?: string;
}

/**
 * Health gate: a relay that has failed 8+ times this session without a
 * single success is skipped (auto-rotation — e.g. the .onion relay on a
 * clearnet browser). One success instantly re-enables it.
 */
const RELAY_FAIL_GATE = 8;

export interface PublisherConfig {
  /** Host-injected signer: template → signed event. The indexer identity
   *  (never the user's personal key) is the signer's concern. */
  signer: (event: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }) => Promise<NostrEvent>;
  /** Host-injected relay transport. MUST throw on failure — per-relay
   *  health tracking and the outbox depend on it. */
  publish: (relayUrl: string, event: NostrEvent) => Promise<void>;
  /** The publish relay set (conformance: ≥2, ≥1 SIP-01-aware). */
  relays: string[];
  storage: CrawlerStorage;
  clock?: () => number;
}

export interface PublishResult {
  normalizedUrl: string;
  /** Relays that accepted the event (0 → held in the outbox). */
  delivered: number;
}

export class Publisher {
  private readonly relayHealth = new Map<string, RelayHealth>();
  private readonly clock: () => number;

  constructor(private readonly config: PublisherConfig) {
    this.clock = config.clock ?? Date.now;
  }

  private recordRelay(relayUrl: string, success: boolean, error?: unknown): void {
    const entry = this.relayHealth.get(relayUrl) ?? { ok: 0, fail: 0, lastOk: 0 };
    if (success) {
      entry.ok++;
      entry.lastOk = this.clock();
      entry.lastError = undefined;
    } else {
      entry.fail++;
      entry.lastError = error instanceof Error ? error.message : String(error);
    }
    this.relayHealth.set(relayUrl, entry);
  }

  /** Snapshot of per-relay health for the host UI. */
  getRelayHealth(): Record<string, RelayHealth> {
    return Object.fromEntries(this.relayHealth);
  }

  private isRelayGated(relayUrl: string): boolean {
    const entry = this.relayHealth.get(relayUrl);
    return entry !== undefined && entry.ok === 0 && entry.fail >= RELAY_FAIL_GATE;
  }

  /**
   * Publish a signed event to all publish relays (best-effort).
   * Returns the number of relays that accepted it.
   */
  private async publishToRelays(signedEvent: NostrEvent): Promise<number> {
    const relays = this.config.relays.filter((url) => !this.isRelayGated(url));
    if (relays.length === 0) return 0;

    const results = await Promise.allSettled(
      relays.map(async (url) => {
        await this.config.publish(url, signedEvent);
        this.recordRelay(url, true);
      }),
    );

    let accepted = 0;
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        accepted++;
      } else {
        this.recordRelay(relays[i]!, false, result.reason);
      }
    });
    return accepted;
  }

  /**
   * Publish a pre-signed event again (outbox flush). True when at least
   * one relay accepted it.
   */
  async republishEvent(event: NostrEvent): Promise<boolean> {
    return (await this.publishToRelays(event)) > 0;
  }

  /** Drain the outbox through the relay lane. Returns events delivered. */
  async flushObservationOutbox(): Promise<number> {
    return this.config.storage.flushOutbox((event) => this.republishEvent(event));
  }

  /**
   * Build, sign, and publish one web index observation (kind 39697).
   *
   * Returns null when the input is not indexable (non-http(s) URL, empty
   * title). Relay failures are swallowed into the outbox — indexing is
   * best-effort and must never break the crawl loop.
   */
  async publishIndexObservation(
    input: IndexObservationInput,
  ): Promise<PublishResult | null> {
    const normalized = normalizeIndexUrl(input.url);
    if (!normalized) return null;

    // C-1 clamp (defense in depth — the parser already drops non-positive
    // claims): page-claimed dates ≤ 0 are dropped before the builder.
    const published =
      input.published !== undefined && Number.isFinite(input.published) && input.published > 0
        ? Math.floor(input.published)
        : undefined;

    const template = await buildIndexEvent({ ...input, url: normalized, published });
    if (!template) return null;

    const signedEvent = await this.config.signer({
      kind: template.kind,
      created_at: Math.floor(this.clock() / 1000), // never future-dated
      tags: template.tags,
      content: template.content,
    });

    const delivered = await this.publishToRelays(signedEvent);
    if (delivered === 0) {
      await this.config.storage.enqueueOutbox(signedEvent, this.clock());
    }
    return { normalizedUrl: normalized, delivered };
  }

  /** Publish a pre-built heartbeat (kind 16919). Best-effort; a missed
   *  beat just reads as offline until the next one. Not outboxed. */
  async publishHeartbeatEvent(event: NostrEvent): Promise<void> {
    await this.publishToRelays(event);
  }
}
