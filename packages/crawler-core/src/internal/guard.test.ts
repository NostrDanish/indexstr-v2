/**
 * guard.test.ts — UNION port of indexstr ssrf.test.ts + crawlstr
 * safety.test.ts, plus blueprint §2.1 vectors (`.home.arpa`, `.corp`).
 * These encode the P0 SSRF security properties — every vector below must
 * NEVER be fetched, directly or via the proxy.
 */

import { describe, it, expect, test } from 'vitest';
import {
  assertPublicUrl,
  isPrivateHost,
  isPrivateUrl,
  isPubliclyFetchable,
  SsrRefusal,
} from './guard';

describe('isPrivateHost', () => {
  test('loopback in every form', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('foo.localhost')).toBe(true);
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('127.1.2.3')).toBe(true);
    // WHATWG URL normalization collapses weird IPv4 reps before we see them:
    expect(isPrivateUrl('http://0x7f000001/')).toBe(true); // hex 127.0.0.1
    expect(isPrivateUrl('http://2130706433/')).toBe(true); // decimal 127.0.0.1
  });

  test('RFC-1918 and link-local (incl. cloud metadata)', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('10.255.255.255')).toBe(true);
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
    expect(isPrivateHost('192.168.1.1')).toBe(true);
    expect(isPrivateHost('169.254.169.254')).toBe(true); // cloud metadata
    expect(isPrivateHost('169.254.0.1')).toBe(true);
    expect(isPrivateHost('0.0.0.0')).toBe(true);
  });

  test('CGNAT shared address space', () => {
    expect(isPrivateHost('100.64.0.1')).toBe(true);
    expect(isPrivateHost('100.127.255.254')).toBe(true);
    expect(isPrivateHost('100.63.255.255')).toBe(false); // just outside
  });

  test('IPv6 loopback, ULA, link-local, mapped-v4', () => {
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('[::1]')).toBe(true);
    expect(isPrivateHost('fc00::1')).toBe(true);
    expect(isPrivateHost('fd12:3456::1')).toBe(true);
    expect(isPrivateHost('fe80::1')).toBe(true);
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateHost('::ffff:7f00:1')).toBe(true);
    expect(isPrivateHost('::ffff:10.0.0.5')).toBe(true);
    expect(isPrivateHost('::ffff:192.168.0.1')).toBe(true);
  });

  test('non-public TLD-ish names fail closed', () => {
    expect(isPrivateHost('printer.local')).toBe(true);
    expect(isPrivateHost('nas.internal')).toBe(true);
    expect(isPrivateHost('nas.lan')).toBe(true);
    expect(isPrivateHost('router.home')).toBe(true);
    expect(isPrivateHost('svc.intranet')).toBe(true);
    expect(isPrivateHost('metadata.google.internal')).toBe(true);
    expect(isPrivateHost('')).toBe(true);
  });

  test('IPv4-mapped/compatible IPv6 bypasses (::ffff: and :: forms)', () => {
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateHost('[::ffff:127.0.0.1]')).toBe(true);
    expect(isPrivateHost('::ffff:169.254.169.254')).toBe(true);
    // Deprecated IPv4-compatible form — previously slipped through as "public".
    expect(isPrivateHost('::127.0.0.1')).toBe(true);
    expect(isPrivateHost('::7f00:1')).toBe(true);
    expect(isPrivateHost('::10.0.0.9')).toBe(true);
    // Mapped/compatible forms with PUBLIC embedded v4 still pass.
    expect(isPrivateHost('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateHost('::8.8.8.8')).toBe(false);
  });

  test('NAT64 / 6to4 / Teredo embedded-v4 bypasses', () => {
    // NAT64 64:ff9b::/96 — embedded v4 in the last 32 bits.
    expect(isPrivateHost('64:ff9b::127.0.0.1')).toBe(true);
    expect(isPrivateHost('64:ff9b::a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isPrivateHost('64:ff9b::808:808')).toBe(false); // 8.8.8.8 — public
    // 6to4 2002::/16 — embedded v4 in words 1–2.
    expect(isPrivateHost('2002:7f00:1::')).toBe(true); // 127.0.0.1
    expect(isPrivateHost('2002:a9fe:a9fe::')).toBe(true); // 169.254.169.254
    expect(isPrivateHost('2002:808:808::')).toBe(false); // 8.8.8.8 — public
    // Teredo 2001:0000::/32 — client v4 = last 32 bits XOR 0xffffffff.
    expect(isPrivateHost('2001:0::80fe:fffe')).toBe(true); // 127.1.0.1 client
    expect(isPrivateHost('2001:0::3fff:fdd2')).toBe(true); // 192.0.2.45 client
  });

  test('IPv6 site-local and discard-only ranges', () => {
    expect(isPrivateHost('fec0::1')).toBe(true); // fec0::/10 site-local
    expect(isPrivateHost('feff::1')).toBe(true);
    expect(isPrivateHost('100::1')).toBe(true); // 100::/64 discard-only
    expect(isPrivateHost('100:1::')).toBe(false); // outside the /64
  });

  test('decimal/hex/octal and short-form IPv4 literals', () => {
    expect(isPrivateHost('2130706433')).toBe(true); // decimal 127.0.0.1
    expect(isPrivateHost('0x7f000001')).toBe(true); // hex 127.0.0.1
    expect(isPrivateHost('0177.0.0.1')).toBe(true); // octal first byte
    expect(isPrivateHost('127.1')).toBe(true); // short form
    expect(isPrivateHost('10.1')).toBe(true);
    expect(isPrivateHost('0xA9FEA9FE')).toBe(true); // 169.254.169.254
    expect(isPrivateHost('134744072')).toBe(false); // 8.8.8.8 decimal
    expect(isPrivateHost('8.8')).toBe(false); // 8.0.0.8 — public
  });

  test('reserved / benchmarking / documentation IPv4 ranges', () => {
    expect(isPrivateHost('192.0.0.1')).toBe(true); // 192.0.0.0/24
    expect(isPrivateHost('192.0.2.1')).toBe(true); // TEST-NET-1
    expect(isPrivateHost('198.18.0.1')).toBe(true); // benchmarking /15
    expect(isPrivateHost('198.19.255.255')).toBe(true);
    expect(isPrivateHost('198.51.100.7')).toBe(true); // TEST-NET-2
    expect(isPrivateHost('203.0.113.9')).toBe(true); // TEST-NET-3
    expect(isPrivateHost('224.0.0.1')).toBe(true); // multicast /4
    expect(isPrivateHost('240.0.0.1')).toBe(true); // reserved /4
    expect(isPrivateHost('255.255.255.255')).toBe(true); // broadcast
    expect(isPrivateHost('223.255.255.255')).toBe(false); // just outside /4
  });

  test('public hosts pass', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('172.15.0.1')).toBe(false); // just outside 172.16/12
    expect(isPrivateHost('11.0.0.1')).toBe(false);
    expect(isPrivateHost('2606:4700:4700::1111')).toBe(false);
  });

  test('isPrivateUrl fails closed on garbage', () => {
    expect(isPrivateUrl('not a url at all')).toBe(true);
    expect(isPrivateUrl('https://example.com/public/page')).toBe(false);
    expect(isPrivateUrl('http://192.168.0.200/admin')).toBe(true);
  });
});

describe('isPubliclyFetchable — SSRF guard', () => {
  it('allows ordinary public https URLs', () => {
    expect(isPubliclyFetchable('https://example.com/page')).toBe(true);
    expect(isPubliclyFetchable('https://en.wikipedia.org/wiki/Nostr')).toBe(true);
  });

  it('refuses non-http(s) schemes', () => {
    expect(isPubliclyFetchable('file:///etc/passwd')).toBe(false);
    expect(isPubliclyFetchable('javascript:alert(1)')).toBe(false);
    expect(isPubliclyFetchable('data:text/html,<p>hi</p>')).toBe(false);
    expect(isPubliclyFetchable('ftp://example.com/')).toBe(false);
  });

  it('refuses localhost and friends (incl. blueprint .home.arpa / .corp)', () => {
    expect(isPubliclyFetchable('http://localhost:8080/admin')).toBe(false);
    expect(isPubliclyFetchable('http://foo.localhost/')).toBe(false);
    expect(isPubliclyFetchable('http://printer.local/')).toBe(false);
    expect(isPubliclyFetchable('http://nas.internal/')).toBe(false);
    expect(isPubliclyFetchable('http://metadata.google.internal/')).toBe(false);
    expect(isPubliclyFetchable('http://router.home.arpa/')).toBe(false);
    expect(isPubliclyFetchable('http://intranet.corp/')).toBe(false);
  });

  it('refuses loopback IPv4 in all its forms', () => {
    expect(isPubliclyFetchable('http://127.0.0.1/')).toBe(false);
    expect(isPubliclyFetchable('http://127.1/')).toBe(false); // short form
    expect(isPubliclyFetchable('http://2130706433/')).toBe(false); // integer form
    expect(isPubliclyFetchable('http://0x7f000001/')).toBe(false); // hex
    expect(isPubliclyFetchable('http://017700000001/')).toBe(false); // octal
  });

  it('refuses RFC1918 and link-local IPv4', () => {
    expect(isPubliclyFetchable('http://10.0.0.5/')).toBe(false);
    expect(isPubliclyFetchable('http://192.168.1.1/')).toBe(false);
    expect(isPubliclyFetchable('http://172.16.0.1/')).toBe(false);
    expect(isPubliclyFetchable('http://172.31.255.255/')).toBe(false);
    expect(isPubliclyFetchable('http://169.254.169.254/latest/meta-data')).toBe(false);
  });

  it('refuses 0.x, CGNAT, and benchmark ranges', () => {
    expect(isPubliclyFetchable('http://0.0.0.0/')).toBe(false);
    expect(isPubliclyFetchable('http://100.64.0.1/')).toBe(false);
    expect(isPubliclyFetchable('http://198.18.0.1/')).toBe(false);
  });

  it('refuses loopback/ULA/link-local IPv6', () => {
    expect(isPubliclyFetchable('http://[::1]/')).toBe(false);
    expect(isPubliclyFetchable('http://[fd00::1]/')).toBe(false);
    expect(isPubliclyFetchable('http://[fe80::1]/')).toBe(false);
    expect(isPubliclyFetchable('http://[::ffff:127.0.0.1]/')).toBe(false);
  });

  it('allows public IP literals (not everything numeric is private)', () => {
    expect(isPubliclyFetchable('http://8.8.8.8/')).toBe(true);
    expect(isPubliclyFetchable('http://1.1.1.1/')).toBe(true);
  });

  it('refuses IPv4-embedded IPv6 bypass vectors', () => {
    expect(isPubliclyFetchable('http://[::ffff:127.0.0.1]/')).toBe(false);
    expect(isPubliclyFetchable('http://[::ffff:7f00:1]/')).toBe(false);
    expect(isPubliclyFetchable('http://[::ffff:a9fe:a9fe]/')).toBe(false);
    expect(isPubliclyFetchable('http://[::127.0.0.1]/')).toBe(false);
    expect(isPubliclyFetchable('http://[::7f00:1]/')).toBe(false);
    expect(isPubliclyFetchable('http://[64:ff9b::127.0.0.1]/')).toBe(false);
    expect(isPubliclyFetchable('http://[64:ff9b::a9fe:a9fe]/')).toBe(false);
    expect(isPubliclyFetchable('http://[2002:7f00:1::]/')).toBe(false);
    expect(isPubliclyFetchable('http://[2002:a9fe:a9fe::]/')).toBe(false);
    expect(isPubliclyFetchable('http://[2001::80ff:fffe]/')).toBe(false);
    expect(isPubliclyFetchable('http://[fec0::1]/')).toBe(false);
  });

  it('allows public IPv6 — the guard must not over-block', () => {
    expect(isPubliclyFetchable('http://[2606:4700:4700::1111]/')).toBe(true);
    expect(isPubliclyFetchable('http://[64:ff9b::808:808]/')).toBe(true);
  });

  it('refuses garbage', () => {
    expect(isPubliclyFetchable('not a url')).toBe(false);
    expect(isPubliclyFetchable('')).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  it('throws SsrRefusal on private targets, accepts public ones', () => {
    expect(() => assertPublicUrl('http://169.254.169.254/latest/meta-data')).toThrow(SsrRefusal);
    expect(() => assertPublicUrl('https://example.com/')).not.toThrow();
  });
});
