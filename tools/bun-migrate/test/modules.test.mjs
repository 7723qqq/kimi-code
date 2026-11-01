/**
 * Module-level replacements: node:sqlite and node:http.
 *
 * These are report-only by design, so the tests prove the *why*: each recorded
 * divergence must be reproducible, and each must keep the entry out of the
 * automatic path. A divergence that stops reproducing means the entry is stale
 * and should be reconsidered, not that the test should be deleted.
 */
import { describe, expect, it } from 'bun:test';

import { moduleReplacementFor, MODULE_REPLACEMENTS } from '../src/modules-map.mjs';

describe('table invariants', () => {
  it('every entry names what it verified and what it cannot do', () => {
    for (const entry of MODULE_REPLACEMENTS) {
      expect(entry.verified.length).toBeGreaterThan(0);
      expect(entry.divergences.length).toBeGreaterThan(0);
      expect(entry.requiredPrologue.length).toBeGreaterThan(0);
      expect(entry.summary.length).toBeGreaterThan(20);
    }
  });

  it('none of them is offered as an automatic rewrite', () => {
    for (const entry of MODULE_REPLACEMENTS) {
      expect(`${entry.id}=${entry.effect}`).toBe(`${entry.id}=report-only`);
    }
  });

  it('looks up by the node: specifier', () => {
    expect(moduleReplacementFor('node:sqlite')?.to).toBe('bun:sqlite');
    expect(moduleReplacementFor('node:http')?.to).toBe('Bun.serve');
    expect(moduleReplacementFor('node:fs')).toBeUndefined();
  });
});

describe('node:sqlite divergences reproduce', () => {
  it('get() returns undefined on one side and null on the other', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { Database } = await import('bun:sqlite');
    const node = new DatabaseSync(':memory:');
    const bun = new Database(':memory:');
    try {
      const nodeEmpty = node.prepare('SELECT 1 AS a').get() === undefined;
      expect(nodeEmpty).toBe(false);
      const empty = 'SELECT 1 AS a WHERE 0';
      expect(node.prepare(empty).get()).toBeUndefined();
      expect(bun.prepare(empty).get()).toBeNull();
    } finally {
      node.close();
      bun.close();
    }
  });

  it('Bun silently rounds a large integer unless safeIntegers is set', async () => {
    const { Database } = await import('bun:sqlite');
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE big (v INTEGER)');
      const value = 9007199254740993n;
      db.prepare('INSERT INTO big (v) VALUES (?)').run(value);

      const unsafe = db.prepare('SELECT v FROM big').get();
      expect(typeof unsafe.v).toBe('number');
      expect(BigInt(unsafe.v) === value).toBe(false);
      expect(BigInt(unsafe.v)).toBe(9007199254740992n);

      const statement = db.prepare('SELECT v FROM big');
      statement.safeIntegers(true);
      const safe = statement.get();
      expect(typeof safe.v).toBe('bigint');
      expect(safe.v).toBe(value);
    } finally {
      db.close();
    }
  });

  it('node:sqlite refuses the same value by default', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE big (v INTEGER)');
      db.prepare('INSERT INTO big (v) VALUES (?)').run(9007199254740993n);
      let code;
      try {
        db.prepare('SELECT v FROM big').get();
      } catch (error) {
        code = error.code;
      }
      expect(code).toBe('ERR_OUT_OF_RANGE');

      const statement = db.prepare('SELECT v FROM big');
      statement.setReadBigInts(true);
      expect(statement.get().v).toBe(9007199254740993n);
    } finally {
      db.close();
    }
  });

  it('the everyday path matches, which is why the entry lists the exceptions', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { Database } = await import('bun:sqlite');
    const node = new DatabaseSync(':memory:');
    const bun = new Database(':memory:');
    try {
      const schema = 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL)';
      node.exec(schema);
      bun.exec(schema);
      const insert = 'INSERT INTO t (name, score) VALUES (?, ?)';
      node.prepare(insert).run('a', 1.5);
      bun.prepare(insert).run('a', 1.5);
      const select = 'SELECT name, score FROM t';
      expect(bun.prepare(select).all()).toEqual(node.prepare(select).all());
      expect(bun.prepare(select).get()).toEqual(node.prepare(select).get());
      expect([...bun.prepare(select).iterate()]).toEqual([...node.prepare(select).iterate()]);
    } finally {
      node.close();
      bun.close();
    }
  });

  it('run() reports the same change count and rowid', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { Database } = await import('bun:sqlite');
    const node = new DatabaseSync(':memory:');
    const bun = new Database(':memory:');
    try {
      node.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
      bun.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
      const a = node.prepare('INSERT INTO t (name) VALUES (?)').run('x');
      const b = bun.prepare('INSERT INTO t (name) VALUES (?)').run('x');
      expect(b.changes).toBe(a.changes);
      expect(String(b.lastInsertRowid)).toBe(String(a.lastInsertRowid));
    } finally {
      node.close();
      bun.close();
    }
  });
});

describe('node:http to Bun.serve is a different model', () => {
  it('a Bun.serve handler takes a Request and returns a Response', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        return Response.json({ path: url.pathname + url.search, method: request.method });
      },
    });
    try {
      const response = await fetch(`http://localhost:${server.port}/hello?a=1`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ path: '/hello?a=1', method: 'GET' });
    } finally {
      await server.stop();
    }
  });

  it('the port comes from the returned object, not from a listen callback', () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    try {
      expect(typeof server.port).toBe('number');
      expect(server.port).toBeGreaterThan(0);
    } finally {
      server.stop(true);
    }
  });

  it('records that the response is a Response, not a writable stream', () => {
    const entry = moduleReplacementFor('node:http');
    const shapes = entry.divergences.map((item) => item.behaviour);
    expect(shapes).toContain('handler shape');
    expect(shapes).toContain('request body');
    expect(entry.missing).toContain('res.write');
  });
});
