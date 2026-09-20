import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SqliteReader } from './sqlite';

/**
 * Parser validation against the real bundled collection databases.
 * These are the exact files the loader fetches at runtime — if the parser
 * walks them correctly here, it walks them correctly in the browser.
 */

const COLLECTIONS_DIR = join(__dirname, '../../public/collections');

function loadDb(name: string): ArrayBuffer {
  const buf = readFileSync(join(COLLECTIONS_DIR, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe('SqliteReader', () => {
  test('rejects non-sqlite input', () => {
    // ≥100 bytes so the magic-header check (not the size check) is exercised.
    const notSqlite = new TextEncoder().encode('<!doctype html>'.repeat(10)).buffer;
    expect(() => new SqliteReader(notSqlite)).toThrow(/bad magic/);
  });

  test.each([
    'videogames.db',
    'books.db',
    'memes.db',
    'movies.db',
    'music.db',
    'feeds.db',
    'awesomelists.db',
    'top.db',
  ])('parses %s: header, tables, and a full linkdatamodel scan', async (file) => {
    const db = new SqliteReader(loadDb(file));
    expect(db.pageSize).toBe(4096);
    expect(db.pageCount).toBeGreaterThan(0);

    const tables = new Map(db.listTables().map((t) => [t.name, t]));
    expect(tables.has('linkdatamodel')).toBe(true);

    const links = tables.get('linkdatamodel')!;
    expect(links.rootPage).toBeGreaterThan(0);

    const columns = SqliteReader.tableColumns(links.sql);
    const iLink = columns.indexOf('link');
    expect(iLink).toBeGreaterThanOrEqual(0);

    let rows = 0;
    let urlRows = 0;
    await db.scanTable(links.rootPage, (values) => {
      rows++;
      const link = values[iLink];
      if (typeof link === 'string' && link.includes('://')) urlRows++;
    });

    expect(rows).toBeGreaterThan(0);
    // Most rows carry a URL-shaped link (scraper artifacts allowed).
    expect(urlRows).toBeGreaterThan(rows * 0.5);
  }, 60_000);

  // music.db: 201 source rows (several collections ship an empty
  // sourcedatamodel — e.g. feeds.db — so the fixture choice matters).
  test('sourcedatamodel rows carry URL-shaped sources', async () => {
    const db = new SqliteReader(loadDb('music.db'));
    const tables = new Map(db.listTables().map((t) => [t.name, t]));
    const sources = tables.get('sourcedatamodel');
    expect(sources).toBeDefined();

    const columns = SqliteReader.tableColumns(sources!.sql);
    const iUrl = columns.indexOf('url');
    expect(iUrl).toBeGreaterThanOrEqual(0);

    let rows = 0;
    await db.scanTable(sources!.rootPage, (values) => {
      const url = values[iUrl];
      if (typeof url === 'string' && url.includes('://')) rows++;
    });
    expect(rows).toBeGreaterThan(0);
  }, 60_000);
});
