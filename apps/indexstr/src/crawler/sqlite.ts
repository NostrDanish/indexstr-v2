/**
 * Minimal read-only SQLite file parser — just enough to full-scan a table.
 *
 * Why this exists: Indexstr ships curated URL collections as raw SQLite
 * database files in /public/collections. Pulling in sql.js would add a WASM
 * binary (and require relaxing the CSP in index.html), so instead we parse
 * the file format directly. A read-only table scan only needs:
 *
 *   - the 100-byte database header (magic, page size, text encoding)
 *   - b-tree page walking (interior 0x05 / leaf 0x0D table pages)
 *   - record decoding (varints + serial types 0–9, text, blob)
 *   - overflow page chains for large payloads
 *
 * Reference: https://www.sqlite.org/fileformat2.html
 *
 * Limitations by design: UTF-8 databases only, no indexes, no queries —
 * sequential scans only. That is all the collection loader needs.
 */

export type SqlValue = string | number | Uint8Array | null;

export interface SqliteTableInfo {
  name: string;
  rootPage: number;
  sql: string;
}

const textDecoder = new TextDecoder();

interface Varint {
  value: number;
  /** Bytes consumed (1–9). */
  size: number;
}

/** Read a SQLite varint (1–9 bytes, big-endian 7-bit groups). */
function readVarint(view: DataView, offset: number): Varint {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const b = view.getUint8(offset + i);
    if (b & 0x80) {
      value = value * 128 + (b & 0x7f);
    } else {
      value = value * 128 + b;
      return { value, size: i + 1 };
    }
  }
  // 9th byte contributes all 8 bits.
  value = value * 256 + view.getUint8(offset + 8);
  return { value, size: 9 };
}

/** Decode a big-endian two's-complement integer of 1–8 bytes. */
function readInt(view: DataView, offset: number, bytes: number): number {
  if (bytes <= 4) {
    let value = 0;
    for (let i = 0; i < bytes; i++) value = value * 256 + view.getUint8(offset + i);
    // Sign-extend.
    const signBit = 2 ** (bytes * 8 - 1);
    if (value >= signBit) value -= signBit * 2;
    return value;
  }
  // 6 or 8 bytes: accumulate via BigInt for safety, then narrow.
  let big = 0n;
  for (let i = 0; i < bytes; i++) big = (big << 8n) | BigInt(view.getUint8(offset + i));
  const bits = BigInt(bytes * 8);
  if (big >= 1n << (bits - 1n)) big -= 1n << bits;
  return Number(big);
}

export class SqliteReader {
  private readonly view: DataView;
  readonly pageSize: number;
  readonly pageCount: number;
  private readonly reserved: number;
  /** Usable bytes per page (page size minus reserved region). */
  private readonly usable: number;

  constructor(buffer: ArrayBuffer) {
    if (buffer.byteLength < 100) throw new Error('Not a SQLite file (too small)');
    this.view = new DataView(buffer);

    const magic = new Uint8Array(buffer, 0, 16);
    const expected = 'SQLite format 3';
    for (let i = 0; i < expected.length; i++) {
      if (magic[i] !== expected.charCodeAt(i)) {
        throw new Error('Not a SQLite file (bad magic)');
      }
    }

    const ps = this.view.getUint16(16);
    this.pageSize = ps === 1 ? 65536 : ps;
    this.reserved = this.view.getUint8(20);
    this.usable = this.pageSize - this.reserved;

    const encoding = this.view.getUint32(56);
    if (encoding !== 1) throw new Error(`Unsupported text encoding ${encoding} (need UTF-8)`);

    this.pageCount = Math.floor(buffer.byteLength / this.pageSize);
  }

  private pageStart(page: number): number {
    return (page - 1) * this.pageSize;
  }

  /** List all tables from sqlite_master (lives on page 1). */
  listTables(): SqliteTableInfo[] {
    const tables: SqliteTableInfo[] = [];
    this.scanPageSync(1, (values) => {
      // sqlite_master: type, name, tbl_name, rootpage, sql
      const [type, name, , rootPage, sql] = values;
      if (type === 'table' && typeof name === 'string' && typeof rootPage === 'number') {
        tables.push({ name, rootPage, sql: typeof sql === 'string' ? sql : '' });
      }
    });
    return tables;
  }

  /**
   * Extract column names (in order) from a CREATE TABLE statement.
   * Handles quoted identifiers and ignores table-level constraints.
   */
  static tableColumns(sql: string): string[] {
    const open = sql.indexOf('(');
    const close = sql.lastIndexOf(')');
    if (open < 0 || close <= open) return [];

    // Split the body on top-level commas (paren-depth aware).
    const body = sql.slice(open + 1, close);
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of body) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current);

    const columns: string[] = [];
    for (const part of parts) {
      const def = part.trim();
      if (!def) continue;
      // Skip table-level constraints.
      const keyword = def.split(/\s/, 1)[0].toUpperCase();
      if (['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT'].includes(keyword)) continue;
      // Column name: first token, possibly quoted with " ` or [].
      const m = def.match(/^"([^"]+)"|^`([^`]+)`|^\[([^\]]+)\]|^(\S+)/);
      const name = m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4];
      if (name) columns.push(name);
    }
    return columns;
  }

  /** True when the column definition is an INTEGER PRIMARY KEY (rowid alias). */
  static isRowidAlias(sql: string, column: string): boolean {
    const re = new RegExp(
      '["`\\[]?' + column + '["`\\]]?\\s+INTEGER[^,]*PRIMARY\\s+KEY',
      'i',
    );
    return re.test(sql);
  }

  /**
   * Full-scan a table b-tree, invoking onRow for every record.
   * Yields to the event loop periodically so large scans don't block the UI.
   * Returns the number of rows read.
   */
  async scanTable(
    rootPage: number,
    onRow: (values: SqlValue[], rowid: number) => void,
    onProgress?: (pagesScanned: number, totalPages: number) => void,
  ): Promise<number> {
    let rows = 0;
    let pages = 0;
    const stack: number[] = [rootPage];
    const seen = new Set<number>();

    while (stack.length > 0) {
      const page = stack.pop()!;
      if (seen.has(page)) continue; // corrupt-file guard
      seen.add(page);

      this.walkPage(page, stack, (values, rowid) => {
        rows++;
        onRow(values, rowid);
      });

      pages++;
      if (pages % 128 === 0) {
        onProgress?.(pages, this.pageCount);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    onProgress?.(pages, this.pageCount);
    return rows;
  }

  /** Synchronous page walk used for sqlite_master (small, no yielding needed). */
  private scanPageSync(rootPage: number, onRow: (values: SqlValue[], rowid: number) => void): void {
    const stack: number[] = [rootPage];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const page = stack.pop()!;
      if (seen.has(page)) continue;
      seen.add(page);
      this.walkPage(page, stack, onRow);
    }
  }

  /**
   * Walk one b-tree page. Interior pages push child pages onto the stack;
   * leaf pages decode records.
   */
  private walkPage(
    page: number,
    childStack: number[],
    onRow: (values: SqlValue[], rowid: number) => void,
  ): void {
    const start = this.pageStart(page);
    if (start < 0 || start + this.pageSize > this.view.byteLength) return;

    // Page 1 carries the 100-byte database header before the b-tree header.
    const headerOffset = start + (page === 1 ? 100 : 0);
    const type = this.view.getUint8(headerOffset);
    const cellCount = this.view.getUint16(headerOffset + 3);
    const headerSize = type === 0x02 || type === 0x05 ? 12 : 8;

    if (type === 0x05) {
      // Interior table page: cells are [child page u32][rowid varint].
      const pointerArray = headerOffset + headerSize;
      for (let i = 0; i < cellCount; i++) {
        const cellOffset = start + this.view.getUint16(pointerArray + i * 2);
        childStack.push(this.view.getUint32(cellOffset));
      }
      // Right-most pointer.
      childStack.push(this.view.getUint32(headerOffset + 8));
      return;
    }

    if (type !== 0x0d) return; // Not a table leaf — index pages are unused here.

    const pointerArray = headerOffset + headerSize;
    for (let i = 0; i < cellCount; i++) {
      const cellOffset = start + this.view.getUint16(pointerArray + i * 2);
      let cursor = cellOffset;

      const payloadLen = readVarint(this.view, cursor);
      cursor += payloadLen.size;
      const rowid = readVarint(this.view, cursor);
      cursor += rowid.size;

      const payload = this.readPayload(cursor, payloadLen.value);
      if (payload) onRow(this.decodeRecord(payload), rowid.value);
    }
  }

  /**
   * Read a cell payload, following the overflow chain when the payload
   * spills beyond what fits locally on the leaf page.
   */
  private readPayload(offset: number, total: number): Uint8Array | null {
    const maxLocal = this.usable - 35;
    const minLocal = Math.floor(((this.usable - 12) * 32) / 255) - 23;

    let local: number;
    if (total <= maxLocal) {
      local = total;
    } else {
      const k = minLocal + ((total - minLocal) % (this.usable - 4));
      local = k <= maxLocal ? k : minLocal;
    }

    if (offset + local > this.view.byteLength) return null;
    const out = new Uint8Array(total);
    out.set(new Uint8Array(this.view.buffer, offset, local), 0);

    if (local >= total) return out;

    // Overflow: 4-byte next-page pointer, then (usable - 4) bytes per page.
    let nextPage = this.view.getUint32(offset + local);
    let written = local;
    let guard = 0;
    while (nextPage !== 0 && written < total && guard++ < this.pageCount) {
      const pageOffset = this.pageStart(nextPage);
      if (pageOffset + 4 > this.view.byteLength) break;
      const following = this.view.getUint32(pageOffset);
      const chunk = Math.min(this.usable - 4, total - written);
      if (pageOffset + 4 + chunk > this.view.byteLength) break;
      out.set(new Uint8Array(this.view.buffer, pageOffset + 4, chunk), written);
      written += chunk;
      nextPage = following;
    }

    return written >= total ? out : out.subarray(0, written);
  }

  /** Decode a record (header of serial types + data body) into values. */
  private decodeRecord(payload: Uint8Array): SqlValue[] {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

    const headerLen = readVarint(view, 0);
    const serialTypes: number[] = [];
    let cursor = headerLen.size;
    while (cursor < headerLen.value) {
      const st = readVarint(view, cursor);
      serialTypes.push(st.value);
      cursor += st.size;
    }

    let dataOffset = headerLen.value;
    const values: SqlValue[] = [];
    for (const st of serialTypes) {
      if (st === 0) {
        values.push(null);
      } else if (st >= 1 && st <= 4) {
        // Serial types 1–4 are big-endian ints of 1, 2, 3 and 4 bytes.
        const bytes = st === 3 ? 3 : st;
        values.push(readInt(view, dataOffset, bytes));
        dataOffset += bytes;
      } else if (st === 5) {
        values.push(readInt(view, dataOffset, 6));
        dataOffset += 6;
      } else if (st === 6) {
        values.push(readInt(view, dataOffset, 8));
        dataOffset += 8;
      } else if (st === 7) {
        values.push(view.getFloat64(dataOffset));
        dataOffset += 8;
      } else if (st === 8) {
        values.push(0);
      } else if (st === 9) {
        values.push(1);
      } else if (st >= 12) {
        const len = st % 2 === 0 ? (st - 12) / 2 : (st - 13) / 2;
        const slice = payload.subarray(dataOffset, dataOffset + len);
        if (st % 2 === 0) {
          values.push(new Uint8Array(slice)); // blob
        } else {
          values.push(textDecoder.decode(slice)); // text
        }
        dataOffset += len;
      } else {
        values.push(null); // 10/11 reserved
      }
    }
    return values;
  }
}
