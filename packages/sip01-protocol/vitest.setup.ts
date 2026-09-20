/**
 * jsdom does not implement WebCrypto's subtle interface; Node >= 20 ships a
 * full global `crypto`. Re-point the jsdom global at Node's webcrypto when
 * `crypto.subtle` is missing so SHA-256 hashing works in tests exactly as it
 * does in browsers and in production Node.
 */
import { webcrypto } from 'node:crypto';

if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}
