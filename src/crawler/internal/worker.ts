/**
 * worker.ts — the Web Worker half of the parse/hash/enrich pool (P3).
 *
 * Loaded by workerpool.ts via `new Worker(new URL('./worker.ts',
 * import.meta.url), { type: 'module' })` so Vite bundles it cleanly in the
 * consuming apps. Parses HTML with linkedom (pure JS — DOMParser with
 * text/html is not reliably available in workers), hashes the extracted
 * text (crypto.subtle is available in workers), and optionally runs the
 * enrich module. Payloads are structured-cloneable data only: raw HTML
 * string in, ProcessedPage out.
 *
 * This file is NEVER statically imported (it is the worker entry point);
 * Node/vitest environments use the InlineProcessor fallback instead.
 */

import { parseHTML } from 'linkedom';

import { enrichPage } from './modules/enrich';
import {
  hashContent,
  parsePageFromDocument,
  type ProcessedPage,
  type WorkerPageRequest,
  type WorkerPageResponse,
} from './workerpool';

// Minimal worker-global typing (lib.dom's `self` is Window-shaped).
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerPageRequest>) => void) | null;
  postMessage(message: WorkerPageResponse): void;
};

scope.onmessage = async (event: MessageEvent<WorkerPageRequest>): Promise<void> => {
  const { id, html, baseUrl, enrich } = event.data;
  try {
    // linkedom's document is behaviorally equivalent for everything the
    // union parser touches (spike: 22/23 corpus pages byte-identical) but
    // is not typed as a DOM Document.
    const { document } = parseHTML(html);
    const parsed = parsePageFromDocument(document as unknown as Document, baseUrl);
    const contentHash = await hashContent(parsed.text);
    const result: ProcessedPage = {
      parsed,
      contentHash,
      ...(enrich ? { enrichment: enrichPage(parsed, baseUrl) } : {}),
    };
    scope.postMessage({ id, ok: true, result });
  } catch (error) {
    // The pool reprocesses failed pages on the main thread (fidelity first).
    scope.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
