/**
 * scheduler-sim.test.ts — the PERMANENT P3 acceptance gate (blueprint §3.2).
 *
 * Fake-clock discrete-event simulation of the parallel slot scheduler:
 * 10k zipf-distributed jobs across 500 domains, robots.txt (+30% feeds) as
 * same-lane scheduled requests on first contact, 10% of domains with a 10 s
 * crawl-delay, 2% with 120 s (must cap at 60 s), page fetch 0.8–2 s, seeded
 * RNG. Ported from the P3 derisk spike (p3-spike-report.md §3) with the
 * finding-#7 fix applied: pages/hour is RESERVED AT REQUEST START
 * (reserve-on-dispatch), making the budget window a hard ceiling.
 *
 * Invariants asserted over every request start/completion:
 *   (i)   ≤1 concurrent request per domain, always;
 *   (ii)  ≥ minInterval (or crawl-delay, capped 60 s) between requests to
 *         one domain — robots/feed requests INCLUDED;
 *   (iii) the pages/hour sliding window NEVER exceeds the limit;
 *   (iv)  raising slots never raises the per-site rate.
 *
 * Throughput acceptance (blueprint §3.2): ~500 pages/h at default budgets;
 * ≥2,000 pages/h ceiling at raised settings (slots 8, budget lifted).
 */

import { describe, expect, it } from 'vitest';

/* ---------------------------------------------------------------------- */
/* Simulation core (mirrors the engine's dispatch ordering):               */
/*   pick → politeness check+set → budget reserve (sync) → fetch → release */
/* ---------------------------------------------------------------------- */

interface SimConfig {
  label: string;
  slots: number;
  minIntervalMs: number;
  maxCrawlDelayMs: number;
  /** pages/hour budget; Infinity = lifted. */
  pagesPerHour: number;
  seed: number;
}

interface SimJob {
  domain: string;
  kind: 'page' | 'robots' | 'feed';
  first: boolean;
}

interface LogEntry {
  t: number;
  domain: string;
  kind: string;
}

function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR = 3_600_000;

function makeJobs(rng: () => number, nJobs = 10_000, nDomains = 500): SimJob[] {
  // Zipf-ish: domain rank r gets ~1/r share of jobs.
  const weights = Array.from({ length: nDomains }, (_, i) => 1 / (i + 1));
  const totalW = weights.reduce((a, b) => a + b, 0);
  const counts = weights.map((w) => Math.max(1, Math.round((w / totalW) * nJobs)));
  const jobs: SimJob[] = [];
  for (let d = 0; d < nDomains; d++) {
    for (let j = 0; j < counts[d]!; j++) {
      jobs.push({ domain: `site${d}.example.com`, kind: 'page', first: j === 0 });
    }
  }
  // Interleave so the queue isn't grouped by domain (realistic intake order).
  for (let i = jobs.length - 1; i > 0; i--) {
    const k = Math.floor(rng() * (i + 1));
    [jobs[i], jobs[k]] = [jobs[k]!, jobs[i]!];
  }
  return jobs;
}

interface SimResult {
  label: string;
  wallHours: number;
  pagesPerHourActual: number;
  startLog: LogEntry[];
  completionLog: LogEntry[];
  crawlDelay: Map<string, number>;
  minIntervalMs: number;
  maxCrawlDelayMs: number;
  slots: number;
}

function simulate(cfg: SimConfig): SimResult {
  const rng = mulberry32(cfg.seed);
  const { slots: SLOT_COUNT, minIntervalMs, maxCrawlDelayMs, pagesPerHour, label } = cfg;

  const queue = makeJobs(rng);
  const totalJobs = queue.length;

  // Per-domain crawl-delay: 10% at 10 s, 2% at 120 s (must cap at 60 s).
  const crawlDelay = new Map<string, number>();
  for (const d of new Set(queue.map((j) => j.domain))) {
    const r = rng();
    if (r < 0.02) crawlDelay.set(d, 120_000);
    else if (r < 0.12) crawlDelay.set(d, 10_000);
  }
  const intervalFor = (d: string): number =>
    Math.max(minIntervalMs, Math.min(crawlDelay.get(d) ?? 0, maxCrawlDelayMs));

  const lastCompletion = new Map<string, number>();
  const inFlight = new Set<string>();
  const slots = Array.from({ length: SLOT_COUNT }, () => ({
    busyUntil: 0,
    domain: null as string | null,
    kind: null as string | null,
  }));
  const completionLog: LogEntry[] = [];
  const startLog: LogEntry[] = [];
  let now = 0;
  let pagesDone = 0;

  // Sorted page RESERVATION (request-start) times — the budget window counts
  // starts, mirroring meter.recordFetchAttempt at dispatch (finding #7 fix).
  const pageStarts: number[] = [];
  const addPageStart = (t: number): void => {
    if (pageStarts.length === 0 || t >= pageStarts[pageStarts.length - 1]!) {
      pageStarts.push(t);
      return;
    }
    let lo = 0;
    let hi = pageStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pageStarts[mid]! <= t) lo = mid + 1;
      else hi = mid;
    }
    pageStarts.splice(lo, 0, t);
  };
  const pagesInWindow = (t: number): number => {
    let lo = 0;
    let hi = pageStarts.length;
    const cut = t - HOUR;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pageStarts[mid]! <= cut) lo = mid + 1;
      else hi = mid;
    }
    return pageStarts.length - lo;
  };
  const budgetOk = (t: number): boolean =>
    !Number.isFinite(pagesPerHour) || pagesInWindow(t) < pagesPerHour;
  const budgetUnblockAt = (t: number): number => {
    if (!Number.isFinite(pagesPerHour) || budgetOk(t)) return Infinity;
    const n = pageStarts.length;
    return n >= pagesPerHour ? pageStarts[n - pagesPerHour]! + HOUR + 0.001 : Infinity;
  };

  let iterations = 0;
  while (pagesDone < totalJobs) {
    if (++iterations > 5_000_000) throw new Error('sim stuck');
    // 1. Complete finished slots.
    for (const s of slots) {
      if (s.domain && s.busyUntil <= now) {
        inFlight.delete(s.domain);
        lastCompletion.set(s.domain, s.busyUntil);
        completionLog.push({ t: s.busyUntil, domain: s.domain, kind: s.kind! });
        if (s.kind === 'page') pagesDone++;
        s.domain = null;
      }
    }
    // 2. Start jobs in free slots (queue order; skip politeness-blocked).
    let started = false;
    for (const s of slots) {
      if (s.domain) continue;
      let idx = -1;
      for (let i = 0; i < queue.length; i++) {
        const j = queue[i]!;
        if (inFlight.has(j.domain)) continue; // invariant (i)
        const last = lastCompletion.get(j.domain) ?? -Infinity;
        if (now - last < intervalFor(j.domain) - 1e-6) continue; // (ii)
        if (j.kind === 'page' && !budgetOk(now)) continue; // (iii) reserve-on-dispatch
        idx = i;
        break;
      }
      if (idx >= 0) {
        const j = queue.splice(idx, 1)[0]!;
        if (j.kind === 'page' && j.first) {
          // First contact: robots.txt through the SAME lane first.
          queue.splice(idx, 0, j);
          j.first = false;
          if (rng() < 0.3) {
            queue.splice(idx + 1, 0, { domain: j.domain, kind: 'feed', first: false });
          }
          const dur = 200 + rng() * 300;
          inFlight.add(j.domain);
          s.busyUntil = now + dur;
          s.domain = j.domain;
          s.kind = 'robots';
          startLog.push({ t: now, domain: j.domain, kind: 'robots' });
        } else {
          const dur = j.kind === 'feed' ? 200 + rng() * 300 : 800 + rng() * 1200;
          inFlight.add(j.domain);
          s.busyUntil = now + dur;
          s.domain = j.domain;
          s.kind = j.kind;
          startLog.push({ t: now, domain: j.domain, kind: j.kind });
          if (j.kind === 'page') addPageStart(now); // RESERVE AT START
        }
        started = true;
      }
    }
    if (pagesDone >= totalJobs) break;
    if (!started) {
      // 3. Advance the clock to the earliest unblock (computed, not polled).
      const nextCompletion = Math.min(
        ...slots.filter((s) => s.domain).map((s) => s.busyUntil),
        Infinity,
      );
      let nextDomainUnblock = Infinity;
      const seen = new Set<string>();
      for (const j of queue) {
        if (seen.has(j.domain)) continue;
        seen.add(j.domain);
        if (inFlight.has(j.domain)) continue;
        const last = lastCompletion.get(j.domain);
        if (last === undefined) continue;
        nextDomainUnblock = Math.min(nextDomainUnblock, last + intervalFor(j.domain));
        if (seen.size >= 50) break;
      }
      const candidates = [nextCompletion, nextDomainUnblock, budgetUnblockAt(now)].filter(
        (t) => t > now,
      );
      const next = Math.min(...candidates);
      if (!Number.isFinite(next)) throw new Error(`deadlock [${label}] at ${now}`);
      now = next;
    }
  }
  const wallMs = Math.max(...completionLog.map((c) => c.t));
  const wallHours = wallMs / HOUR;
  return {
    label,
    wallHours,
    pagesPerHourActual: totalJobs / wallHours,
    startLog,
    completionLog,
    crawlDelay,
    minIntervalMs,
    maxCrawlDelayMs,
    slots: SLOT_COUNT,
  };
}

/* ---------------------------------------------------------------------- */
/* Invariant assertions                                                    */
/* ---------------------------------------------------------------------- */

/** (i) ≤1 concurrent per domain + (ii) ≥ interval between starts (robots
 *  and feeds included), with the crawl-delay cap honored. */
function politenessViolations(res: SimResult): string[] {
  const fails: string[] = [];
  const byDomain = new Map<string, LogEntry[]>();
  for (const s of res.startLog) {
    const list = byDomain.get(s.domain) ?? [];
    list.push(s);
    byDomain.set(s.domain, list);
  }
  for (const [domain, starts] of byDomain) {
    // Sweep-line over start/completion pairs (completions are matched in
    // order per domain — slots are FIFO per domain by invariant i).
    const comps = res.completionLog.filter((c) => c.domain === domain);
    const events: Array<{ t: number; d: number }> = [];
    for (let i = 0; i < starts.length; i++) {
      events.push({ t: starts[i]!.t, d: +1 });
      if (comps[i]) events.push({ t: comps[i]!.t, d: -1 });
    }
    events.sort((a, b) => a.t - b.t || a.d - b.d);
    let open = 0;
    for (const e of events) {
      open += e.d;
      if (open > 1) {
        fails.push(`(i) ${domain} had ${open} concurrent at t=${e.t}`);
        break;
      }
    }
    const interval = Math.max(
      res.minIntervalMs,
      Math.min(res.crawlDelay.get(domain) ?? 0, res.maxCrawlDelayMs),
    );
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i]!.t - starts[i - 1]!.t;
      if (gap < interval - 1e-9) {
        fails.push(`(ii) ${domain} gap ${gap.toFixed(0)}ms < ${interval}ms`);
      }
    }
    // Crawl-delay CAP: a 120 s robots delay must bind at exactly 60 s — gaps
    // need only reach the cap, never the raw delay.
    if ((res.crawlDelay.get(domain) ?? 0) > res.maxCrawlDelayMs) {
      const gaps = starts.slice(1).map((s, i) => s.t - starts[i]!.t);
      const minGap = Math.min(...gaps);
      if (minGap < res.maxCrawlDelayMs - 1e-9) {
        fails.push(`cap: ${domain} gap ${minGap} < cap ${res.maxCrawlDelayMs}`);
      }
    }
  }
  return fails;
}

/** (iii) Max pages started in ANY 1h sliding window (hard ceiling). */
function maxPagesInAnyWindow(res: SimResult): number {
  const times = res.startLog
    .filter((c) => c.kind === 'page')
    .map((c) => c.t)
    .sort((a, b) => a - b);
  let max = 0;
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    while (times[i]! - times[j]! >= HOUR) j++;
    max = Math.max(max, i - j + 1);
  }
  return max;
}

/** (iv) Max sustained single-domain page rate (pages/h). */
function maxSingleDomainRate(res: SimResult): number {
  const domainTimes = new Map<string, number[]>();
  for (const c of res.completionLog) {
    if (c.kind !== 'page') continue;
    const list = domainTimes.get(c.domain) ?? [];
    list.push(c.t);
    domainTimes.set(c.domain, list);
  }
  let maxRate = 0;
  for (const ts of domainTimes.values()) {
    ts.sort((a, b) => a - b);
    if (ts.length > 1) {
      maxRate = Math.max(maxRate, (ts.length - 1) / ((ts[ts.length - 1]! - ts[0]!) / HOUR));
    }
  }
  return maxRate;
}

/* ---------------------------------------------------------------------- */
/* The acceptance gate                                                     */
/* ---------------------------------------------------------------------- */

describe('scheduler simulation — 10k jobs / 500 domains / fake clock (P3 acceptance, blueprint §3.2)', () => {
  const SCENARIOS: SimConfig[] = [
    { label: 'defaults', slots: 4, minIntervalMs: 5000, maxCrawlDelayMs: 60_000, pagesPerHour: 500, seed: 1 },
    { label: 'raised budget', slots: 8, minIntervalMs: 5000, maxCrawlDelayMs: 60_000, pagesPerHour: 2000, seed: 2 },
    { label: 'budget lifted (4 slots)', slots: 4, minIntervalMs: 5000, maxCrawlDelayMs: 60_000, pagesPerHour: Infinity, seed: 3 },
    { label: 'eco', slots: 4, minIntervalMs: 8000, maxCrawlDelayMs: 60_000, pagesPerHour: 450, seed: 4 },
    { label: 'ceiling (8 slots, lifted)', slots: 8, minIntervalMs: 5000, maxCrawlDelayMs: 60_000, pagesPerHour: Infinity, seed: 5 },
  ];

  it(
    'politeness invariants (i)(ii)(iv) hold with ZERO violations in all scenarios',
    { timeout: 180_000 },
    () => {
      for (const sc of SCENARIOS) {
        const res = simulate(sc);
        const fails = politenessViolations(res);
        expect(fails, `[${sc.label}] ${fails.slice(0, 3).join('; ')}`).toEqual([]);
        // (iv): the per-site rate never exceeds the interval-imposed cap,
        // whatever the slot count.
        const siteCap = HOUR / res.minIntervalMs;
        expect(maxSingleDomainRate(res), `[${sc.label}] per-site rate`).toBeLessThanOrEqual(siteCap);
      }
    },
  );

  it(
    'invariant (iii): pages/hour windows are HARD CEILINGS (reserve-on-dispatch)',
    { timeout: 180_000 },
    () => {
      for (const sc of SCENARIOS.filter((s) => Number.isFinite(s.pagesPerHour))) {
        const res = simulate(sc);
        const max = maxPagesInAnyWindow(res);
        expect(max, `[${sc.label}] window max ${max} > ${sc.pagesPerHour}`).toBeLessThanOrEqual(
          sc.pagesPerHour,
        );
      }
    },
  );

  it(
    'throughput: ~500 pages/h at defaults, ≥2,000 pages/h ceiling at raised settings',
    { timeout: 180_000 },
    () => {
      const defaults = simulate(SCENARIOS[0]!);
      // Budget-bound: delivers just under/at the 500/h budget (spike: 505).
      expect(defaults.pagesPerHourActual).toBeGreaterThanOrEqual(450);
      expect(defaults.pagesPerHourActual).toBeLessThanOrEqual(560);

      const eco = simulate(SCENARIOS[3]!);
      expect(eco.pagesPerHourActual).toBeGreaterThanOrEqual(400);
      expect(eco.pagesPerHourActual).toBeLessThanOrEqual(500);

      // Budgets lifted: the ceiling is ≥2,000 pages/h at both slot counts
      // (spike: 3,767 @ 4 slots, 3,808 @ 8 — the per-domain interval, not
      // slot count, is the binding constraint).
      const lifted4 = simulate(SCENARIOS[2]!);
      const lifted8 = simulate(SCENARIOS[4]!);
      expect(lifted4.pagesPerHourActual).toBeGreaterThanOrEqual(2000);
      expect(lifted8.pagesPerHourActual).toBeGreaterThanOrEqual(2000);
      // (iv) throughput corollary: 8 slots add little once domain diversity
      // drains — slots raise utilization, not per-site rate.
      expect(lifted8.pagesPerHourActual).toBeLessThanOrEqual(lifted4.pagesPerHourActual * 1.25);
    },
  );
});
