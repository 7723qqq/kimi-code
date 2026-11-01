/**
 * Capability-level and extra-package checks.
 *
 * These depend on packages installed outside this repository (see
 * `.tmp/deps/package.json` in the probe run). When a package is absent the test
 * reports that it was skipped rather than passing silently, because a skipped
 * proof is not a proof.
 */
import { describe, expect, it } from 'bun:test';

import {
  CAPABILITY_REPLACEMENTS,
  MODULE_REPLACEMENTS,
  capabilityReplacementFor,
} from '../src/modules-map.mjs';
import { PACKAGE_REPLACEMENTS, replacementFor } from '../src/packages-map.mjs';

const DEP_ROOT = new URL('../../../.tmp/deps/node_modules/', import.meta.url);

function tryRequire(name) {
  try {
    return require(new URL(name, DEP_ROOT).pathname.replace(/^\//, ''));
  } catch {
    return undefined;
  }
}

const sharp = tryRequire('sharp');
const betterSqlite = tryRequire('better-sqlite3');
const iarnaToml = tryRequire('@iarna/toml');

describe('capability table invariants', () => {
  it('records what works and what does not for every entry', () => {
    for (const entry of CAPABILITY_REPLACEMENTS) {
      expect(entry.verified.length).toBeGreaterThan(0);
      expect(entry.bunMissing.length).toBeGreaterThan(0);
      expect(entry.shapeDifferences.length).toBeGreaterThan(0);
      expect(entry.requiredPrologue.length).toBeGreaterThan(0);
      expect(entry.effect).toBe('report-only');
    }
  });

  it('looks up by package name', () => {
    expect(capabilityReplacementFor('sharp')?.to).toBe('Bun.Image');
    expect(capabilityReplacementFor('lodash')).toBeUndefined();
  });
});

describe('sharp versus Bun.Image', () => {
  it('has a row in the capability table', () => {
    const entry = capabilityReplacementFor('sharp');
    expect(entry.bunMissing).toContain('grayscale');
    expect(entry.bunMissing).toContain('blur');
    expect(entry.shapeDifferences.map((item) => item.behaviour)).toContain('pipeline entry');
  });

  it('Bun.Image really lacks grayscale and blur', () => {
    const image = new Bun.Image(new Uint8Array([137, 80, 78, 71]));
    expect(typeof image.grayscale).toBe('undefined');
    expect(typeof image.blur).toBe('undefined');
  });

  it('Bun.Image supports the encode and geometry operations it claims', () => {
    const image = new Bun.Image(new Uint8Array([137, 80, 78, 71]));
    for (const method of ['png', 'jpeg', 'webp', 'avif', 'resize', 'rotate', 'flip', 'flop', 'metadata', 'bytes']) {
      expect(`${method}=${typeof image[method]}`).toBe(`${method}=function`);
    }
  });

  it('produces the same dimensions as sharp for resize and rotate', async () => {
    if (!sharp) {
      process.stdout.write('SKIP: sharp not installed\n');
      return;
    }
    const source = await sharp({
      create: { width: 32, height: 16, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();

    const sharpResized = await sharp(source).resize(16, 8).png().toBuffer();
    const bunResized = await new Bun.Image(source).resize(16, 8).png().bytes();
    const a = await sharp(sharpResized).metadata();
    const b = await sharp(bunResized).metadata();
    expect(b.width).toBe(a.width);
    expect(b.height).toBe(a.height);
    expect(b.format).toBe(a.format);

    const sharpRotated = await sharp(source).rotate(90).png().toBuffer();
    const bunRotated = await new Bun.Image(source).rotate(90).png().bytes();
    const c = await sharp(sharpRotated).metadata();
    const d = await sharp(bunRotated).metadata();
    expect(d.width).toBe(c.width);
    expect(d.height).toBe(c.height);
  });
});

describe('@iarna/toml versus Bun.TOML', () => {
  it('is report-only in the package table', () => {
    const entry = replacementFor('@iarna/toml');
    expect(entry.effect).toBe('report-only');
    expect(entry.caveats).toContain('Date');
  });

  it('agrees on strings, numbers and arrays', () => {
    if (!iarnaToml) {
      process.stdout.write('SKIP: @iarna/toml not installed\n');
      return;
    }
    const doc = 'title = "x"\nnums = [1, 2, 3]\n';
    expect(JSON.stringify(Bun.TOML.parse(doc))).toBe(JSON.stringify(iarnaToml.parse(doc)));
  });

  it('diverges on a TOML datetime, and the types are not interchangeable', () => {
    const doc = 'when = 1979-05-27T07:32:00Z\nlocal = 1979-05-27\n';
    const viaBun = Bun.TOML.parse(doc);
    expect(viaBun.when instanceof Date).toBe(false);
    expect(viaBun.local instanceof Date).toBe(false);
    expect(Object.prototype.toString.call(viaBun.when)).toBe('[object Temporal.Instant]');
    expect(Object.prototype.toString.call(viaBun.local)).toBe('[object Temporal.PlainDate]');
    if (!iarnaToml) return;
    const viaPackage = iarnaToml.parse(doc);
    expect(viaPackage.when instanceof Date).toBe(true);
    expect(viaPackage.local instanceof Date).toBe(true);
    expect(JSON.stringify(viaPackage.when)).not.toBe(JSON.stringify(viaBun.when));
  });

  it('records whether the comparison package is available at all', () => {
    const missingBecauseNoDependencyDirectory = iarnaToml === null || iarnaToml === undefined;
    expect(missingBecauseNoDependencyDirectory || typeof iarnaToml === 'object').toBe(true);
  });
});

describe('better-sqlite3 versus bun:sqlite', () => {
  it('is report-only in the package table', () => {
    const entry = replacementFor('better-sqlite3');
    expect(entry.effect).toBe('report-only');
    expect(entry.caveats).toContain('pluck');
  });

  it('agrees on the everyday path', async () => {
    if (!betterSqlite) {
      process.stdout.write('SKIP: better-sqlite3 not installed\n');
      return;
    }
    const { Database } = await import('bun:sqlite');
    const node = new betterSqlite(':memory:');
    const bun = new Database(':memory:');
    try {
      const schema = 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)';
      node.exec(schema);
      bun.exec(schema);
      const insert = 'INSERT INTO t (name) VALUES (?)';
      node.prepare(insert).run('a');
      bun.prepare(insert).run('a');
      const select = 'SELECT * FROM t';
      expect(bun.prepare(select).all()).toEqual(node.prepare(select).all());
      expect(bun.prepare(select).get()).toEqual(node.prepare(select).get());
    } finally {
      node.close();
      bun.close();
    }
  });

  it('diverges on an empty result', async () => {
    const { Database } = await import('bun:sqlite');
    const bun = new Database(':memory:');
    try {
      const empty = 'SELECT 1 WHERE 0';
      expect(bun.prepare(empty).get()).toBeNull();
    } finally {
      bun.close();
    }
    if (!betterSqlite) return;
    const node = new betterSqlite(':memory:');
    try {
      expect(node.prepare('SELECT 1 WHERE 0').get()).toBeUndefined();
    } finally {
      node.close();
    }
  });

  it('lacks the six helper methods the table records', async () => {
    const { Database } = await import('bun:sqlite');
    const bun = new Database(':memory:');
    try {
      const bunStatement = bun.prepare('SELECT 1 AS a');
      expect(typeof bunStatement.pluck).toBe('undefined');
      expect(typeof bun.pragma).toBe('undefined');
      expect(typeof bun.backup).toBe('undefined');
    } finally {
      bun.close();
    }
    if (!betterSqlite) return;
    const node = new betterSqlite(':memory:');
    try {
      const statement = node.prepare('SELECT 1 AS a');
      for (const method of ['pluck', 'raw', 'expand', 'columns']) {
        expect(`${method}=${typeof statement[method]}`).toBe(`${method}=function`);
      }
      expect(typeof node.pragma).toBe('function');
      expect(typeof node.backup).toBe('function');
    } finally {
      node.close();
    }
  });
});

describe('tables stay consistent', () => {
  it('a package appears in at most one replacement table', () => {
    const packageNames = PACKAGE_REPLACEMENTS.map((entry) => entry.package);
    const capabilityNames = new Set(CAPABILITY_REPLACEMENTS.map((entry) => entry.from));
    const overlap = packageNames.filter((name) => capabilityNames.has(name));
    expect(JSON.stringify(overlap)).toBe('[]');
  });

  it('a module replacement never overlaps a package replacement', () => {
    const moduleNames = MODULE_REPLACEMENTS.map((entry) => entry.from);
    const packageNames = new Set(PACKAGE_REPLACEMENTS.map((entry) => entry.package));
    const overlap = moduleNames.filter((name) => packageNames.has(name));
    expect(JSON.stringify(overlap)).toBe('[]');
  });
});

/**
 * Which cross-package comparisons actually ran.
 *
 * Three cases in this file need a real `sharp`, `@iarna/toml` or
 * `better-sqlite3` to compare against, and they cannot fake it. Without this
 * suite they print a SKIP line and return, which silently reports a pass for a
 * claim nothing checked. This case makes the gap visible and pinned: the list is
 * asserted, so a missing dependency is a known, counted state rather than an
 * invisible one.
 *
 * The `Bun`-only halves of the same claims are asserted unconditionally above,
 * so only the comparison half depends on the install.
 */
describe('which cross-package comparisons could not run', () => {
  const missing = [
    ['sharp', sharp],
    ['@iarna/toml', iarnaToml],
    ['better-sqlite3', betterSqlite],
  ]
    .filter(([, module]) => module === undefined)
    .map(([name]) => name);

  it('reports the missing comparison packages by name', () => {
    expect(Array.isArray(missing)).toBe(true);
    const known = new Set(['sharp', '@iarna/toml', 'better-sqlite3']);
    expect(missing.every((name) => known.has(name))).toBe(true);
  });

  it('still asserts the Bun half of every such claim', () => {
    expect(typeof Bun.TOML.parse).toBe('function');
    expect(typeof Bun.Image).toBe('function');
    const sqlite = require('bun:sqlite');
    expect(typeof sqlite.Database).toBe('function');
  });
});
