/**
 * net.test.ts — the guardedFetch choke point. THE structural test of the
 * module boundary: every fetch path refuses private targets BEFORE any
 * request; redirects re-checked; bodies stream-capped; every byte metered;
 * failures classified permanent (never retried) vs transient.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { Net } from './net';
import { Meter } from './meter';

const PROXY = 'https://proxy.example/?url={href}';

function makeNet(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, meter?: Meter) {
  const fetchFn = vi.fn(fetchImpl);
  const net = new Net({ fetchFn: fetchFn as unknown as typeof fetch, proxyTemplate: PROXY, meter });
  return { net, fetchFn };
}

const HTML = '<!doctype html><html><head><title>t</title></head><body><p>hello world</p></body></html>';

afterEach(() => vi.restoreAllMocks());

describe('the choke point: no request for private targets, ever', () => {
  it('page fetch of a private URL issues ZERO fetches (direct or proxied)', async () => {
    const { net, fetchFn } = makeNet(async () => new Response(HTML));
    const outcome = await net.guardedFetchPage('http://169.254.169.254/latest/meta-data');
    expect(outcome).toMatchObject({ ok: false, kind: 'permanent', reason: 'ssrf' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('robots/feed/sitemap/probe paths share the same guard', async () => {
    const { net, fetchFn } = makeNet(async () => new Response(''));
    for (const url of ['http://127.0.0.1/robots.txt', 'http://[::ffff:10.0.0.1]/feed.xml']) {
      expect((await net.guardedFetchText(url)).ok).toBe(false);
      expect((await net.guardedFetchXml(url)).ok).toBe(false);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('non-http(s) schemes are refused before fetch', async () => {
    const { net, fetchFn } = makeNet(async () => new Response(HTML));
    expect((await net.guardedFetchPage('file:///etc/passwd')).ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('redirect re-check (direct path)', () => {
  it('a public URL redirecting into private space is discarded', async () => {
    const { net, fetchFn } = makeNet(
      async () =>
        // Simulate a followed redirect: response.url is the final URL.
        new Response(HTML, { status: 200 }),
    );
    // Patch: undici Response.url is read-only, so wrap.
    const fakeResponse = new Response(HTML, { status: 200 });
    Object.defineProperty(fakeResponse, 'url', { value: 'http://192.168.1.1/admin' });
    fetchFn.mockResolvedValue(fakeResponse);

    const outcome = await net.guardedFetchPage('https://example.com/redirector');
    expect(outcome).toMatchObject({ ok: false, kind: 'permanent', reason: 'ssrf' });
    expect(fetchFn).toHaveBeenCalledTimes(1); // no proxy retry after refusal
  });
});

describe('failure classification', () => {
  it('4xx is permanent (never retried, never proxied)', async () => {
    const { net, fetchFn } = makeNet(async () => new Response('nope', { status: 404 }));
    const outcome = await net.guardedFetchPage('https://example.com/missing');
    expect(outcome).toMatchObject({ ok: false, kind: 'permanent', reason: 'http-4xx', status: 404 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('5xx is transient and NOT proxied (v1 parity: only network failures fall back)', async () => {
    const { net, fetchFn } = makeNet(async () => new Response('err', { status: 503 }));
    const outcome = await net.guardedFetchPage('https://example.com/down');
    expect(outcome).toMatchObject({ ok: false, kind: 'transient', reason: 'http-5xx', status: 503 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('network failure falls back to the proxy — the guard vetted the target first', async () => {
    const { net, fetchFn } = makeNet(async (url) => {
      if (String(url).startsWith(PROXY.slice(0, 25))) {
        return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      throw new TypeError('Failed to fetch'); // CORS
    });
    const outcome = await net.guardedFetchPage('https://example.com/page');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.viaProxy).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(String(fetchFn.mock.calls[1]![0])).toContain('proxy.example');
  });

  it('non-HTML payload is a permanent refusal', async () => {
    const { net } = makeNet(
      async () => new Response('{"json":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(await net.guardedFetchPage('https://example.com/api')).toMatchObject({
      ok: false,
      kind: 'permanent',
      reason: 'non-html',
    });
  });

  it('plain 4xx statuses are permanent (400, 401, 403, 404, 410)', async () => {
    for (const status of [400, 401, 403, 404, 410]) {
      const { net, fetchFn } = makeNet(async () => new Response('nope', { status }));
      const outcome = await net.guardedFetchPage('https://example.com/x');
      expect(outcome).toMatchObject({ ok: false, kind: 'permanent', reason: 'http-4xx', status });
      expect(fetchFn).toHaveBeenCalledTimes(1); // never proxied
    }
  });

  it.each([408, 409, 425, 429])(
    'retryable 4xx (%i) is TRANSIENT — eligible for bounded retry, not proxied',
    async (status) => {
      const { net, fetchFn } = makeNet(async () => new Response('busy', { status }));
      const outcome = await net.guardedFetchPage('https://example.com/x');
      expect(outcome).toMatchObject({
        ok: false,
        kind: 'transient',
        reason: 'http-4xx-retryable',
        status,
      });
      expect(fetchFn).toHaveBeenCalledTimes(1); // transient ≠ network: no proxy hop
    },
  );

  it.each([500, 502, 503, 504])('5xx (%i) is transient', async (status) => {
    const { net } = makeNet(async () => new Response('err', { status }));
    expect(await net.guardedFetchPage('https://example.com/x')).toMatchObject({
      ok: false,
      kind: 'transient',
      reason: 'http-5xx',
      status,
    });
  });

  it('a thrown fetch (DNS/CORS/offline) is a transient network failure', async () => {
    const { net } = makeNet(async () => {
      throw new TypeError('Failed to fetch');
    });
    // No proxy configured-hit? PROXY is configured — the proxy ALSO fails
    // here, so the final outcome is the proxied attempt's network failure.
    const outcome = await net.guardedFetchPage('https://example.com/x');
    expect(outcome).toMatchObject({ ok: false, kind: 'transient', reason: 'network' });
  });

  it('an abort is a transient timeout', async () => {
    const { net } = makeNet(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const outcome = await net.guardedFetchPage('https://example.com/x', { timeoutMs: 20 });
    expect(outcome).toMatchObject({ ok: false, kind: 'transient', reason: 'timeout' });
  });

  it('oversize is permanent — never worth a retry', async () => {
    const { net } = makeNet(
      async () =>
        new Response(HTML, {
          status: 200,
          headers: { 'content-type': 'text/html', 'content-length': '999999999' },
        }),
    );
    expect(await net.guardedFetchPage('https://example.com/big', { maxBytes: 1024 }))
      .toMatchObject({ ok: false, kind: 'permanent', reason: 'oversize' });
  });
});

describe('stream-capped reads + byte-accurate metering', () => {
  it('content-length above the cap is refused before reading the body', async () => {
    const { net } = makeNet(
      async () =>
        new Response(HTML, {
          status: 200,
          headers: { 'content-type': 'text/html', 'content-length': '999999999' },
        }),
    );
    expect(await net.guardedFetchPage('https://example.com/huge', { maxBytes: 1024 })).toMatchObject({
      ok: false,
      kind: 'permanent',
      reason: 'oversize',
    });
  });

  it('a streaming body is cut off at the cap (no giant allocation)', async () => {
    // 1 MB of 'a' streamed in chunks; cap 64 KB.
    const chunk = new Uint8Array(8192).fill(97);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 128; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const { net, fetchFn } = makeNet(
      async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const meter = new Meter();
    const metered = new Net({
      fetchFn: fetchFn as unknown as typeof fetch,
      proxyTemplate: PROXY,
      meter,
    });
    void net;
    const outcome = await metered.guardedFetchPage('https://example.com/stream', { maxBytes: 64 * 1024 });
    expect(outcome).toMatchObject({ ok: false, kind: 'permanent', reason: 'oversize' });
    // The meter counted what was actually read — not the full 1 MB.
    expect(meter.getSessionTotals().bytes).toBeLessThan(128 * 1024);
    expect(meter.getSessionTotals().bytes).toBeGreaterThan(64 * 1024);
  });

  it('every fetched byte is metered — kept or discarded', async () => {
    const meter = new Meter();
    const { net } = makeNet(
      async () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
      meter,
    );
    const outcome = await net.guardedFetchPage('https://example.com/page');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(meter.getSessionTotals().bytes).toBe(outcome.bytes);
      expect(outcome.bytes).toBe(new TextEncoder().encode(HTML).byteLength);
    }
  });

  it('byte-accurate on CJK/emoji bodies — UTF-8 bytes, NOT UTF-16 code units (audit #9)', async () => {
    // CJK chars: 1 UTF-16 unit but 3 UTF-8 bytes; emoji: a surrogate PAIR
    // (2 UTF-16 units) and 4 UTF-8 bytes. A UTF-16-length meter would
    // undercount this page ~3x.
    const cjk =
      '<!doctype html><html><head><title>日本語のページ</title></head><body><p>' +
      '東京都在住の開発者が絵文字🎉🚀を使う。'.repeat(200) +
      '</p></body></html>';
    const expectedBytes = new TextEncoder().encode(cjk).byteLength;
    expect(expectedBytes).toBeGreaterThan(cjk.length * 2); // proof the page is multi-byte-heavy

    // Stream it in chunks so the byte counter (not response.text()) runs.
    const encoded = new TextEncoder().encode(cjk);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const CHUNK = 4096;
        for (let i = 0; i < encoded.length; i += CHUNK) {
          controller.enqueue(encoded.slice(i, i + CHUNK));
        }
        controller.close();
      },
    });
    const meter = new Meter();
    const { net } = makeNet(
      async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } }),
      meter,
    );

    const outcome = await net.guardedFetchPage('https://example.com/cjk');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.bytes).toBe(expectedBytes); // exact UTF-8 wire bytes
      expect(outcome.bytes).toBeGreaterThan(outcome.body.length); // ≠ UTF-16 units
      expect(meter.getSessionTotals().bytes).toBe(expectedBytes);
    }
  });

  it('a LYING content-length (too small) does not defeat the cap — the stream is cut mid-read (audit F7/#7)', async () => {
    // 1 MB body, header claims 100 bytes. The cap must fire during the
    // read, not after a full buffer.
    const chunk = new Uint8Array(8192).fill(97);
    let chunksEnqueued = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 128; i++) {
          controller.enqueue(chunk);
          chunksEnqueued++;
        }
        controller.close();
      },
    });
    const meter = new Meter();
    const { net } = makeNet(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/html', 'content-length': '100' }, // a lie
        }),
      meter,
    );

    const outcome = await meterlessGuard(net, 64 * 1024);
    expect(outcome).toMatchObject({ ok: false, kind: 'permanent', reason: 'oversize' });
    // The meter proves the read STOPPED shortly after the cap — it did not
    // consume the whole 1 MB body before checking size.
    const bytes = meter.getSessionTotals().bytes;
    expect(bytes).toBeGreaterThan(64 * 1024); // the crossing chunk counts
    expect(bytes).toBeLessThanOrEqual(64 * 1024 + 8192); // …and nothing more
    expect(chunksEnqueued).toBe(128); // producer pushed; consumer stopped reading
  });

  it('no content-length at all: cap still enforced by the byte counter', async () => {
    const chunk = new Uint8Array(8192).fill(97);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 128; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const { net } = makeNet(
      async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    expect(await net.guardedFetchPage('https://example.com/nocl', { maxBytes: 32 * 1024 }))
      .toMatchObject({ ok: false, kind: 'permanent', reason: 'oversize' });
  });
});

/** Helper: call guardedFetchPage with a byte cap. */
async function meterlessGuard(net: Net, maxBytes: number) {
  return net.guardedFetchPage('https://example.com/lying', { maxBytes });
}
