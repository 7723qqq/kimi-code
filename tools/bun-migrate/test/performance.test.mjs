import { describe, expect, it } from 'bun:test';
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
/**
 * Performance regression guards.
 *
 * These do not assert exact multipliers — a busy machine would make the suite
 * flaky. They assert the direction each rule claims, so a rule that says
 * "speed" cannot silently start being slower, and a rule that says
 * "report-only because it measured slower" keeps that property.
 *
 * The full numbers live in PERFORMANCE.md. This file only checks the sign.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';

const nodeAvailable = (() => Bun.spawnSync(['node', '--version']).exitCode === 0)();

function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function benchSync(fn, iterations, rounds = 5) {
  for (let i = 0; i < Math.max(3, iterations / 10); i += 1) fn();
  const samples = [];
  for (let round = 0; round < rounds; round += 1) {
    const t0 = Bun.nanoseconds();
    for (let i = 0; i < iterations; i += 1) fn();
    samples.push((Bun.nanoseconds() - t0) / iterations);
  }
  return median(samples);
}

async function benchAsync(fn, iterations, rounds = 5) {
  for (let i = 0; i < Math.max(3, iterations / 10); i += 1) await fn();
  const samples = [];
  for (let round = 0; round < rounds; round += 1) {
    const t0 = Bun.nanoseconds();
    for (let i = 0; i < iterations; i += 1) await fn();
    samples.push((Bun.nanoseconds() - t0) / iterations);
  }
  return median(samples);
}

describe('speed claims hold', () => {
  it('Bun.CryptoHasher beats createHash', () => {
    const text = 'x'.repeat(1000);
    const nodePer = benchSync(
      () => require('node:crypto').createHash('sha256').update(text).digest('hex'),
      400,
    );
    const bunPer = benchSync(() => new Bun.CryptoHasher('sha256').update(text).digest('hex'), 400);
    expect(nodePer / bunPer).toBeGreaterThan(1.1);
  });

  it('Bun.gzipSync beats gzipSync', () => {
    const text = 'compressible '.repeat(100);
    const nodePer = benchSync(() => require('node:zlib').gzipSync(text), 200);
    // The rule wraps Bun's Uint8Array in a Buffer; measure the rewrite, not the raw call.
    const bunPer = benchSync(() => Buffer.from(Bun.gzipSync(text)), 200);
    expect(nodePer / bunPer).toBeGreaterThan(1.5);
  });

  it('Bun.stripANSI beats stripVTControlCharacters', () => {
    const text = '\u001B[31mred\u001B[0m '.repeat(20);
    const nodePer = benchSync(() => require('node:util').stripVTControlCharacters(text), 800);
    const bunPer = benchSync(() => Bun.stripANSI(text), 800);
    expect(nodePer / bunPer).toBeGreaterThan(2);
  });

  it('Bun.Glob beats globSync on a populated directory', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'perfglob-'));
    try {
      for (let i = 0; i < 200; i += 1) await writeFile(join(dir, `f${i}.yaml`), '');
      const nodePer = benchSync(() => globSync('*.yaml', { cwd: dir }), 30);
      const bunPer = benchSync(() => [...new Bun.Glob('*.yaml').scanSync({ cwd: dir })], 30);
      expect(nodePer / bunPer).toBeGreaterThan(1.2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('report-only claims hold', () => {
  it('Bun.write is not faster than writeFile', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'perfwrite-'));
    try {
      const target = join(dir, 't.txt');
      const body = 'y'.repeat(100_000);
      const nodePer = await benchAsync(() => writeFile(target, body), 40);
      const bunPer = await benchAsync(() => Bun.write(target, body), 40);
      expect(nodePer / bunPer).toBeLessThan(1.2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Bun.file().text() is not faster than readFile', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'perfread-'));
    try {
      const file = join(dir, 'r.txt');
      await writeFile(file, 'z'.repeat(1000));
      const nodePer = await benchAsync(
        () => require('node:fs/promises').readFile(file, 'utf8'),
        200,
      );
      const bunPer = await benchAsync(() => Bun.file(file).text(), 200);
      expect(nodePer / bunPer).toBeLessThan(1.2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('raw deflate bytes still diverge past the block boundary', () => {
    if (!nodeAvailable)
      throw new Error(
        'node must be on PATH: a differential case that skips reports a pass it did not earn',
      );
    const hex = (engine, size) => {
      const source =
        engine === 'node'
          ? `const {deflateRawSync}=require('node:zlib');console.log(Buffer.from(deflateRawSync('x'.repeat(${size}))).toString('hex'));`
          : `console.log(Buffer.from(Bun.deflateSync('x'.repeat(${size}))).toString('hex'));`;
      return Bun.spawnSync([engine, '-e', source]).stdout.toString().trim();
    };
    expect(hex('bun', 200)).toBe(hex('node', 200));
    expect(hex('bun', 5000)).not.toBe(hex('node', 5000));
  });

  it('Bun.deepEquals still ignores an undefined-valued key', () => {
    expect(Bun.deepEquals({ a: undefined }, {})).toBe(true);
    expect(require('node:util').isDeepStrictEqual({ a: undefined }, {})).toBe(false);
  });
});

describe('the speed evidence is measured the way it is documented', () => {
  it('compares implementations in one process, not two', () => {
    const source = [
      "const { createHash } = require('node:crypto');",
      "const buf = 'x'.repeat(1024);",
      'let t = Bun.nanoseconds();',
      'for (let i = 0; i < 300; i += 1) createHash("sha256").update(buf).digest("hex");',
      'const nodePer = (Bun.nanoseconds() - t) / 300;',
      't = Bun.nanoseconds();',
      'for (let i = 0; i < 300; i += 1) new Bun.CryptoHasher("sha256").update(buf).digest("hex");',
      'const bunPer = (Bun.nanoseconds() - t) / 300;',
      'process.stdout.write(JSON.stringify({ nodePer, bunPer }));',
    ].join('\n');
    const result = Bun.spawnSync(['bun', '-e', source]);
    const measured = JSON.parse(result.stdout.toString().trim());
    expect(measured.nodePer).toBeGreaterThan(measured.bunPer);
  });

  it('reaches parity or better for sha512 and md5 at a high iteration count', () => {
    const source = [
      "const { createHash } = require('node:crypto');",
      'const med = (a) => a.toSorted((x, y) => x - y)[Math.floor(a.length / 2)];',
      'function bench(fn, iters, rounds) {',
      '  for (let i = 0; i < 200; i += 1) fn();',
      '  const s = [];',
      '  for (let r = 0; r < rounds; r += 1) {',
      '    const t0 = Bun.nanoseconds();',
      '    for (let i = 0; i < iters; i += 1) fn();',
      '    s.push((Bun.nanoseconds() - t0) / iters);',
      '  }',
      '  return med(s);',
      '}',
      'const out = {};',
      'for (const algo of ["sha512", "md5"]) {',
      '  const buf = "x".repeat(64);',
      '  const n = bench(() => createHash(algo).update(buf).digest("hex"), 3000, 5);',
      '  const b = bench(() => new Bun.CryptoHasher(algo).update(buf).digest("hex"), 3000, 5);',
      '  out[algo] = n / b;',
      '}',
      'process.stdout.write(JSON.stringify(out));',
    ].join('\n');
    const result = Bun.spawnSync(['bun', '-e', source]);
    const ratios = JSON.parse(result.stdout.toString().trim());
    expect(ratios.sha512).toBeGreaterThan(0.9);
    expect(ratios.md5).toBeGreaterThan(0.9);
  });

  it('the per-file scan cost does not grow super-linearly', () => {
    const root = mkdtempSync(join(tmpdir(), 'perf-'));
    try {
      const sizes = [100, 400];
      const times = [];
      for (const size of sizes) {
        const dir = join(root, `p${size}`);
        for (let index = 0; index < size; index += 1) {
          const moduleDir = join(dir, 'src', `m${index % 20}`);
          mkdirSync(moduleDir, { recursive: true });
          writeFileSync(
            join(moduleDir, `f${index}.js`),
            "import { createHash } from 'node:crypto';\nexport const a = (t) => createHash('sha256').update(t).digest('hex');\n",
          );
        }
        writeFileSync(
          join(dir, 'package.json'),
          '{"name":"p","version":"1.0.0","type":"module"}\n',
        );
        const started = Bun.nanoseconds();
        Bun.spawnSync(['bun', 'tools/bun-migrate/src/cli.mjs', 'scan', '--root', dir], {
          cwd: process.cwd(),
          stdout: 'ignore',
          stderr: 'ignore',
        });
        times.push((Bun.nanoseconds() - started) / 1e6);
      }
      const [small, large] = times;
      const growth = large / small;
      const fileRatio = sizes[1] / sizes[0];
      expect(`growth=${growth < fileRatio * 2 ? 'linear' : 'super-linear'}`).toBe('growth=linear');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * What `Bun.gzipSync` actually produces, pinned so the documentation cannot drift
 * back to "byte identical".
 *
 * The claim that survived in three files was a tautology: comparing
 * `require('node:zlib').gzipSync` against `Bun.gzipSync` inside Bun compares one
 * implementation against itself. Against a stream Node produced, the bytes differ
 * for most payloads while both directions still decode. A migration that stores
 * compressed data is safe; one that checksums it is not, and that distinction has
 * to be recorded somewhere a future edit will trip over.
 */
describe('gzip output is interoperable, not byte-identical', () => {
  const PAYLOADS = [
    ['x * 16', 'x'.repeat(16), true],
    ['x * 100', 'x'.repeat(100), true],
    ['x * 1000', 'x'.repeat(1000), false],
    ['x * 1024', 'x'.repeat(1024), false],
    ['x * 2048', 'x'.repeat(2048), false],
    ['hello world * 100', 'hello world'.repeat(100), false],
    ['compressible * 1000', 'compressible '.repeat(1000), false],
  ];

  it('matches Bun own node:zlib, which is the same implementation', () => {
    const text = 'compressible '.repeat(1000);
    const viaNodeSpecifier = require('node:zlib').gzipSync(text);
    const viaBunGlobal = Buffer.from(Bun.gzipSync(text));
    expect(viaBunGlobal.equals(viaNodeSpecifier)).toBe(true);
  });

  for (const [label, payload, expectedIdentical] of PAYLOADS) {
    it(`compared with a real Node stream, ${label} is ${expectedIdentical ? 'identical' : 'different'}`, () => {
      if (!nodeAvailable)
        throw new Error('node must be on PATH: this compares against a stream Node produced');
      const source = `const {gzipSync}=require('node:zlib');process.stdout.write(gzipSync(${JSON.stringify(payload)}).toString('hex'));`;
      const fromNode = Bun.spawnSync(['node', '-e', source]).stdout.toString().trim();
      const fromBun = Buffer.from(Bun.gzipSync(payload)).toString('hex');
      expect(`${label} identical=${fromNode === fromBun}`).toBe(
        `${label} identical=${expectedIdentical}`,
      );
    });
  }

  it('decodes a Node-produced stream', () => {
    if (!nodeAvailable)
      throw new Error('node must be on PATH: this decodes a stream Node produced');
    const text = 'hello world'.repeat(100);
    const source = `const {gzipSync}=require('node:zlib');process.stdout.write(gzipSync(${JSON.stringify(text)}).toString('hex'));`;
    const hex = Bun.spawnSync(['node', '-e', source]).stdout.toString().trim();
    const decoded = Buffer.from(Bun.gunzipSync(Buffer.from(hex, 'hex'))).toString();
    expect(decoded).toBe(text);
  });

  it('states interoperability rather than byte equality in the rule tables', () => {
    const pairings = readFileSync(join(import.meta.dir, '..', 'src', 'pairings.mjs'), 'utf8');
    const surface = readFileSync(join(import.meta.dir, '..', 'src', 'bun-surface.mjs'), 'utf8');
    const gzipSummary = pairings
      .split('\n')
      .find((line) => line.includes('gzipSync(data) -> Buffer.from(Bun.gzipSync(data))'));
    expect(gzipSummary?.includes('byte identical')).toBe(false);
    expect(gzipSummary?.includes('not byte-identical')).toBe(true);
    const gzipNote = surface.split('\n').find((line) => line.includes("bun: 'Bun.gzipSync'"));
    expect(gzipNote?.includes('not to a stream produced by Node')).toBe(true);
  });
});
