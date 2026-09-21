/**
 * Network view — how many Indexstr nodes are heartbeat-visible right now?
 *
 * This queries the app's relay pool for recent kind 16919 heartbeats and
 * counts distinct indexer pubkeys. It is a LOCAL ESTIMATE: your relay view
 * is never the whole network. The UI must label it accordingly.
 *
 * v2 seam: the nostrify pool query is the app's read transport; heartbeat
 * PUBLISHING lives in @sip01/crawler-core, and the heartbeat WIRE SHAPE
 * (kind, TTL, parse/dedupe/liveness) is imported from core — no local
 * mirror of the parsing logic.
 */

import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import {
  dedupeHeartbeats,
  isNodeLive,
  HEARTBEAT_KIND,
  HEARTBEAT_TTL_S,
} from '@sip01/crawler-core';
import { getIndexReadRelays } from '@/lib/indexRelays';

export interface NetworkNodesResult {
  /** Distinct indexers with a heartbeat inside the TTL. */
  activeIndexers: number;
  /** Distinct home shards claimed by those indexers. */
  activeShards: number;
  /** When the estimate was computed (unix ms). */
  sampledAt: number;
}

export function useNetworkNodes(enabled = true) {
  const { nostr } = useNostr();

  return useQuery<NetworkNodesResult>({
    queryKey: ['indexstr-network-nodes'],
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      // A slightly wider window than the TTL, then liveness is decided on
      // the deduped latest-per-node heartbeat (replaceable kind semantics
      // can return stale versions from slow relays).
      const since = Math.floor(Date.now() / 1000) - HEARTBEAT_TTL_S * 2;
      // Read from the SIP-01 pool — heartbeats are published there.
      const events = await nostr.group(getIndexReadRelays()).query(
        [{ kinds: [HEARTBEAT_KIND], since, limit: 500 }],
        { signal },
      );

      const now = Math.floor(Date.now() / 1000);
      const live = dedupeHeartbeats(events).filter((hb) => isNodeLive(hb, now));

      return {
        activeIndexers: live.length,
        activeShards: new Set(live.map((hb) => hb.shard)).size,
        sampledAt: Date.now(),
      };
    },
  });
}
