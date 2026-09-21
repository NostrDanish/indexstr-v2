/**
 * Host-environment capabilities — app-side glue (v2).
 *
 * In v1 `src/crawler/capabilities.ts` fed both the engine's wifi/charging
 * gates and the heartbeat payload. In v2 the heartbeat payload is built
 * inside @sip01/crawler-core (its own coarse snapshot), so what remains
 * here is purely host-side:
 *   1. the dashboard's capability display ("desktop · wifi · charging"), and
 *   2. the WiFi-only / charging-only user settings, which gate whether the
 *      adapter starts the node (a host policy, not a core concern).
 *
 * Privacy rules (unchanged, hard constraints): no precise location, no IP
 * identity, no fine-grained fingerprint; battery rounded to 25% steps,
 * network reduced to a coarse class.
 */

export type NodePlatform = 'mobile' | 'desktop' | 'unknown';

export type NetworkClass = 'wifi-or-better' | 'cellular' | 'slow' | 'offline' | 'unknown';

export interface NodeCapabilities {
  /** Coarse platform class — never a model or OS version. */
  platform: NodePlatform;
  /** Coarse network class. */
  network: NetworkClass;
  /** Battery level rounded down to 25% steps; -1 when unknown. */
  batteryQuarter: number;
  charging: boolean;
}

/** Battery API is non-standard; keep the local typing contained. */
interface BatteryLike {
  level: number;
  charging: boolean;
}

interface ConnectionLike {
  effectiveType?: string;
  type?: string;
}

function connection(): ConnectionLike | undefined {
  return (navigator as unknown as { connection?: ConnectionLike }).connection;
}

function detectPlatform(): NodePlatform {
  const ua = navigator.userAgent ?? '';
  if (/Mobi|Android|iPhone|iPad/i.test(ua)) return 'mobile';
  if (ua) return 'desktop';
  return 'unknown';
}

function detectNetwork(): NetworkClass {
  const conn = connection();
  if (!conn) return 'unknown';
  if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') return 'slow';
  if (conn.type === 'wifi' || conn.effectiveType === '4g') return 'wifi-or-better';
  if (conn.type === 'cellular' || conn.effectiveType === '3g') return 'cellular';
  if (navigator.onLine === false) return 'offline';
  return 'unknown';
}

let cached: { caps: NodeCapabilities; at: number } | null = null;

/**
 * Read the current capability snapshot. Cached for 60s — capabilities are
 * coarse by design, so freshness matters less than avoiding repeated
 * Battery API calls.
 */
export async function getNodeCapabilities(): Promise<NodeCapabilities> {
  if (cached && Date.now() - cached.at < 60_000) return cached.caps;

  let batteryQuarter = -1;
  let charging = false;
  if ('getBattery' in navigator) {
    try {
      const battery = await (
        navigator as unknown as { getBattery(): Promise<BatteryLike> }
      ).getBattery();
      batteryQuarter = Math.min(4, Math.floor(battery.level * 4)); // 0–4
      charging = battery.charging;
    } catch {
      // Battery API unavailable/blocked — leave as unknown.
    }
  }

  const caps: NodeCapabilities = {
    platform: detectPlatform(),
    network: detectNetwork(),
    batteryQuarter,
    charging,
  };
  cached = { caps, at: Date.now() };
  return caps;
}

/**
 * Evaluate the crawl constraints against the live environment — v1
 * `engine.canCrawl()` semantics exactly: a near-empty battery, a slow
 * (2g) connection, and the user's charging-only / WiFi-only settings all
 * pause crawling. Uncheckable constraints (no Connection/Battery API)
 * fail CLOSED only where v1 did (wifiOnly with the API present but
 * unreadable); battery failures fail open, as in v1.
 */
export async function checkCrawlConstraints(settings: {
  wifiOnly: boolean;
  chargingOnly: boolean;
}): Promise<{ ok: boolean; reason?: 'battery' | 'charging' | 'network' | 'wifi' }> {
  if ('getBattery' in navigator) {
    try {
      const battery = await (
        navigator as unknown as { getBattery(): Promise<BatteryLike> }
      ).getBattery();
      if (battery.level < 0.15 && !battery.charging) return { ok: false, reason: 'battery' };
      if (settings.chargingOnly && !battery.charging) return { ok: false, reason: 'charging' };
    } catch {
      // Battery API not available/blocked — continue (v1 behavior).
    }
  }

  if ('connection' in navigator) {
    const conn = connection();
    if (conn?.effectiveType === 'slow-2g' || conn?.effectiveType === '2g') {
      return { ok: false, reason: 'network' };
    }
    if (settings.wifiOnly && conn?.type !== 'wifi' && conn?.effectiveType !== '4g') {
      return { ok: false, reason: 'wifi' };
    }
  }

  return { ok: true };
}
