/**
 * intake.ts — network intake (OPTIONAL module; indexstr on, crawlstr off).
 *
 * Other indexers' kind 39697 observations are discovery signals: every
 * observed URL we haven't crawled and don't already queue becomes a
 * low-priority candidate job (followLinks: false — the network points at
 * pages; our own crawlers decide what's worth re-verifying).
 *
 * Zero coupling: no app code, no central API — just SIP-01 events any
 * relay pool already carries. Abuse guards, in this exact order (the
 * order IS the security property, F1/F6):
 *
 *   structural sanity (kind, widx: d-tag, u tag, not ancient/future)
 *   → normalize → SSRF admission (private URLs never enter the queue)
 *   → dedup BEFORE charging budget (crawled/queued — replayed events must
 *     not burn the victim indexer's session caps; griefing fix)
 *   → crawl-trap heuristics
 *   → per-indexer Sybil cap → per-domain cap
 *   → enqueue through the engine's single admit() path (queue cap).
 *
 * Deliberately NOT a reputation system: no scoring, no memory beyond the
 * session, no central list.
 */

import type { NostrEvent } from '@nostrify/nostrify';
import { WEB_INDEX_KIND, WEB_INDEX_D_PREFIX, normalizeIndexUrl } from '@sip01/protocol';

import { isPrivateUrl } from '../guard';
import { isLikelyCrawlTrap, DomainIntakeGuard, IndexerIntakeGuard } from './traps';

/** Per-domain cap for intake URLs. */
export const INTAKE_DOMAIN_CAP = 200;
/** Per-indexer intake cap (Sybil guard). */
export const INTAKE_INDEXER_CAP = 100;

export interface IntakeResult {
  accepted: number;
  rejected: number;
  ssrfBlocked: number;
  trapsBlocked: number;
}

export interface IntakeDeps {
  /** Host/relay seam: recent kind 39697 events newer than `since` (unix s). */
  query: (since: number, limit: number) => Promise<NostrEvent[]>;
  /** This node's indexer pubkey — own observations are excluded. */
  ownPubkey: string;
  /** True when the URL is already crawled or queued (pre-budget dedup). */
  isKnown: (normalizedUrl: string) => Promise<boolean>;
  /** Enqueue through the engine's admit path (traps/cap/queue insert). */
  enqueue: (normalizedUrl: string) => Promise<boolean>;
  clock?: () => number;
}

export class NetworkIntake {
  /** Newest network-observation timestamp processed (unix seconds). */
  private lastIntakeTs = 0;
  private readonly domainGuard = new DomainIntakeGuard(INTAKE_DOMAIN_CAP);
  private readonly indexerGuard = new IndexerIntakeGuard(INTAKE_INDEXER_CAP);

  constructor(private readonly deps: IntakeDeps) {}

  private clock(): number {
    return (this.deps.clock ?? Date.now)();
  }

  /** How many distinct indexers contributed this session. */
  get indexerCount(): number {
    return this.indexerGuard.indexerCount;
  }

  /** Test-only access to the Sybil guard. */
  get sybilGuard(): IndexerIntakeGuard {
    return this.indexerGuard;
  }

  /** One intake poll. Never throws. */
  async poll(): Promise<IntakeResult> {
    const result: IntakeResult = { accepted: 0, rejected: 0, ssrfBlocked: 0, trapsBlocked: 0 };

    try {
      // Overlap the window by 10 min so slow-arriving events aren't missed.
      const nowS = Math.floor(this.clock() / 1000);
      const since = this.lastIntakeTs > 0 ? this.lastIntakeTs - 600 : nowS - 600;

      const events = await this.deps.query(since, 250);
      let newest = this.lastIntakeTs;

      for (const event of events) {
        if (event.pubkey === this.deps.ownPubkey) continue;
        if (event.created_at > newest) newest = event.created_at;

        // Structural sanity: right kind, widx: d-tag, u tag, not ancient.
        if (event.kind !== WEB_INDEX_KIND) continue;
        const d = event.tags.find(([name]) => name === 'd')?.[1];
        const rawUrl = event.tags.find(([name]) => name === 'u')?.[1];
        if (!d?.startsWith(WEB_INDEX_D_PREFIX) || !rawUrl) {
          result.rejected++;
          continue;
        }
        if (event.created_at < nowS - 86400 || event.created_at > nowS + 3600) {
          result.rejected++;
          continue;
        }

        const normalized = normalizeIndexUrl(rawUrl);
        if (!normalized) {
          result.rejected++;
          continue;
        }

        // SSRF queue-admission check: a network observation must never put
        // a private/loopback/link-local URL into the queue.
        if (isPrivateUrl(normalized)) {
          result.rejected++;
          result.ssrfBlocked++;
          continue;
        }

        // Dedup BEFORE charging any intake budget: replayed or already-known
        // URLs must not burn the per-indexer / per-domain caps — otherwise
        // an attacker rebroadcasting a victim indexer's valid signed events
        // exhausts the victim's session budget (griefing).
        if (await this.deps.isKnown(normalized)) continue; // duplicates aren't rejection news

        if (isLikelyCrawlTrap(normalized)) {
          result.rejected++;
          result.trapsBlocked++;
          continue;
        }

        // Sybil guard: cap per-indexer contribution per session. Only URLs
        // that will actually be queued consume budget.
        if (!this.indexerGuard.allow(event.pubkey)) {
          result.rejected++;
          continue;
        }
        if (!this.domainGuard.allow(normalized)) {
          result.rejected++;
          continue;
        }

        if (await this.deps.enqueue(normalized)) result.accepted++;
      }

      this.lastIntakeTs = Math.max(newest, nowS - 600);
    } catch {
      // Intake is best-effort; a failed poll just tries again next interval.
    }

    return result;
  }
}
