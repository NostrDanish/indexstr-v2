/**
 * robots.test.ts — UNION port of both apps' robots tests (audit finding #1
 * + indexstr defense-in-depth), adapted to the core's Net-backed Robots
 * class. The security property: robots.txt for a private/loopback/
 * link-local target is NEVER fetched (direct or proxied) — and the answer
 * is a REFUSAL (fail closed), not "allowed".
 *
 * Distinct hostnames per test because rules are cached per origin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Net } from './net';
import { Robots, parseRobotsTxt } from './robots';

function mockFetchReturning(status: number, body = '') {
  return vi.fn(async () => new Response(body, { status }));
}

function makeRobots() {
  return new Robots(new Net({ proxyTemplate: 'https://proxy.example/?url={href}' }));
}

describe('robots SSRF guard (audit finding #1)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetchReturning(404));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses to fetch robots.txt for link-local cloud-metadata IPs', async () => {
    const robots = makeRobots();
    const allowed = await robots.shouldCrawlUrl('http://169.254.169.254/latest/meta-data');
    // Fail-CLOSED (indexstr semantics win the union): a private target is a
    // refusal, not "allowed"…
    expect(allowed).toBe(false);
    // …and NOTHING was ever requested, direct or proxied.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses loopback and RFC1918 robots.txt targets', async () => {
    const robots = makeRobots();
    for (const url of [
      'http://127.0.0.1/admin',
      'http://10.0.0.5/internal',
      'http://192.168.1.1/config',
      'http://172.16.0.1/x',
      'http://localhost:8080/y',
      'http://[::1]/z',
    ]) {
      expect(await robots.shouldCrawlUrl(url)).toBe(false);
      expect(await robots.getCrawlDelay(url)).toBe(0);
      expect(await robots.getSitemaps(url)).toEqual([]);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses odd IPv4 forms browsers accept', async () => {
    const robots = makeRobots();
    await robots.shouldCrawlUrl('http://2130706433/'); // 127.0.0.1 as integer
    await robots.shouldCrawlUrl('http://0x7f000001/'); // hex
    await robots.shouldCrawlUrl('http://017700000001/'); // octal
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses IPv6 transition-mechanism targets', async () => {
    const robots = makeRobots();
    expect(await robots.shouldCrawlUrl('http://[::ffff:127.0.0.1]/x')).toBe(false);
    expect(await robots.shouldCrawlUrl('http://[64:ff9b::a9fe:a9fe]/x')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('public host with no robots.txt (404) is allowed — direct attempt only', async () => {
    const robots = makeRobots();
    expect(await robots.shouldCrawlUrl('https://robots-404.example/page')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const requested = vi.mocked(fetch).mock.calls[0]![0] as string;
    expect(requested).toBe('https://robots-404.example/robots.txt');
  });

  it('honours Disallow and Crawl-delay from a fetched robots.txt', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchReturning(200, 'User-agent: *\nDisallow: /private\nCrawl-delay: 2\n'),
    );
    const robots = makeRobots();
    expect(await robots.shouldCrawlUrl('https://rules-example.com/private/thing')).toBe(false);
    expect(await robots.shouldCrawlUrl('https://rules-example.com/public/thing')).toBe(true);
    expect(await robots.getCrawlDelay('https://rules-example.com/public/thing')).toBe(2000);
  });

  it('caches robots per origin (one fetch for many URLs)', async () => {
    const robots = makeRobots();
    await robots.shouldCrawlUrl('https://cached.example/a');
    await robots.shouldCrawlUrl('https://cached.example/b');
    await robots.getCrawlDelay('https://cached.example/c');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('parseRobotsTxt', () => {
  it('parses disallow rules, crawl-delay and sitemaps', () => {
    const rules = parseRobotsTxt(
      'User-agent: *\nDisallow: /admin\nCrawl-delay: 3\nSitemap: https://example.com/sitemap.xml\n',
    );
    expect(rules.disallowed).toEqual(['/admin']);
    expect(rules.crawlDelay).toBe(3000);
    expect(rules.sitemaps).toEqual(['https://example.com/sitemap.xml']);
  });

  it('ignores rules for other user-agents', () => {
    const rules = parseRobotsTxt('User-agent: badbot\nDisallow: /\nUser-agent: *\nDisallow: /x\n');
    expect(rules.disallowed).toEqual(['/x']);
  });

  it('parses Allow rules for the relevant agent only', () => {
    const rules = parseRobotsTxt(
      'User-agent: *\nDisallow: /private\nAllow: /private/public\nUser-agent: badbot\nAllow: /\n',
    );
    expect(rules.disallowed).toEqual(['/private']);
    expect(rules.allowed).toEqual(['/private/public']);
  });

  it('treats an empty Disallow value as no rule (allow-all)', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow:\n');
    expect(rules.disallowed).toEqual([]);
    expect(rules.allowed).toEqual([]);
  });
});

describe('robots Allow + longest-match (P4, RFC 9309)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      mockFetchReturning(
        200,
        'User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /blocked\n',
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a longer Allow overrides a shorter Disallow', async () => {
    const robots = makeRobots();
    expect(await robots.shouldCrawlUrl('https://allow-example.com/private/public/x')).toBe(true);
    expect(await robots.shouldCrawlUrl('https://allow-example.com/private/secret')).toBe(false);
    expect(await robots.shouldCrawlUrl('https://allow-example.com/blocked/y')).toBe(false);
    expect(await robots.shouldCrawlUrl('https://allow-example.com/other/z')).toBe(true);
  });

  it('an Allow tie with Disallow resolves to allowed', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchReturning(200, 'User-agent: *\nDisallow: /same\nAllow: /same\n'),
    );
    const robots = makeRobots();
    expect(await robots.shouldCrawlUrl('https://tie-example.com/same/page')).toBe(true);
  });

  it('Disallow: / still blocks the whole site unless a longer Allow exists', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchReturning(200, 'User-agent: *\nDisallow: /\nAllow: /public\n'),
    );
    const robots = makeRobots();
    expect(await robots.shouldCrawlUrl('https://rootblock.example/private')).toBe(false);
    expect(await robots.shouldCrawlUrl('https://rootblock.example/')).toBe(false);
    expect(await robots.shouldCrawlUrl('https://rootblock.example/public/page')).toBe(true);
  });
});
