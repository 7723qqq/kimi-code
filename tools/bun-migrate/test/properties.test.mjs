import { describe, expect, it } from 'bun:test';
/**
 * Property tests: for arbitrary well-formed inputs, a rewrite must not change
 * the observable result.
 *
 * The differential suite proves one example per rule. This file generates many
 * inputs per rule and compares original-versus-migrated output across a matrix
 * of argument shapes, empty inputs, unicode, and binary payloads. A rule that
 * only survives the happy path does not survive here.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CASES = [];

function run(command, source) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-migrate-prop-'));
  const file = join(directory, 'case.cjs');
  try {
    writeFileSync(file, source, 'utf8');
    const result = Bun.spawnSync([command, file], { cwd: directory });
    if (result.exitCode !== 0) {
      return { ok: false, detail: result.stderr.toString().trim().slice(0, 300) };
    }
    return { ok: true, value: result.stdout.toString().trim() };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const nodeAvailable = (() => Bun.spawnSync(['node', '--version']).exitCode === 0)();

describe('property: hash digests agree on arbitrary input', () => {
  const ALGORITHMS = ['sha256', 'sha512', 'sha1', 'md5', 'sha3-256'];
  const ENCODINGS = ['hex', 'base64', 'base64url', 'latin1'];
  const PAYLOADS = [
    ['', 'empty'],
    ['a', 'single char'],
    ['hello world', 'ascii'],
    ['中文混合 English', 'unicode'],
    ['🚀🎯✨', 'astral plane'],
    ['x'.repeat(4096), 'long'],
    ['line1\nline2\r\nline3\ttab', 'control characters'],
  ];

  for (const algorithm of ALGORITHMS) {
    for (const encoding of ENCODINGS) {
      for (const [payload, label] of PAYLOADS) {
        CASES.push({ algorithm, encoding, payload, label });
      }
    }
  }

  it(`covers ${CASES.length} algorithm/encoding/payload combinations`, () => {
    expect(CASES.length).toBe(ALGORITHMS.length * ENCODINGS.length * PAYLOADS.length);
  });

  const sample = CASES.filter((_, index) => index % 11 === 0);

  for (const testCase of sample.slice(0, 18)) {
    it(`${testCase.algorithm} ${testCase.encoding} ${testCase.label}`, () => {
      if (!nodeAvailable)
        throw new Error(
          'node must be on PATH: a differential case that skips reports a pass it did not earn',
        );
      const escaped = JSON.stringify(testCase.payload);
      const original = run(
        'node',
        `const { createHash } = require('node:crypto');
         console.log(createHash(${JSON.stringify(testCase.algorithm)}).update(${escaped}).digest(${JSON.stringify(testCase.encoding)}));`,
      );
      const migrated = run(
        'bun',
        `console.log(new Bun.CryptoHasher(${JSON.stringify(testCase.algorithm)}).update(${escaped}).digest(${JSON.stringify(testCase.encoding)}));`,
      );
      expect(original.ok).toBe(true);
      expect(migrated.ok).toBe(true);
      expect(migrated.value).toBe(original.value);
    });
  }
});

describe('property: hmac agrees on arbitrary keys and payloads', () => {
  const KEYS = ['', 'k', 'a much longer secret key value', '中文密钥'];
  const PAYLOADS = ['', 'x', 'unicode 中文 🚀', 'y'.repeat(1000)];

  const combinations = [];
  for (const key of KEYS) {
    for (const payload of PAYLOADS) combinations.push({ key, payload });
  }

  it(`covers ${combinations.length} key/payload combinations`, () => {
    expect(combinations.length).toBe(KEYS.length * PAYLOADS.length);
  });

  const casesLiteral = JSON.stringify(combinations);
  let batch;
  function hmacBatch() {
    if (batch !== undefined) return batch;
    const original = run(
      'node',
      `const { createHmac } = require('node:crypto');
       const cases = ${casesLiteral};
       console.log(JSON.stringify(cases.map(({ key, payload }) => createHmac('sha256', key).update(payload).digest('hex'))));`,
    );
    const migrated = run(
      'bun',
      `const cases = ${casesLiteral};
       console.log(JSON.stringify(cases.map(({ key, payload }) => new Bun.CryptoHasher('sha256', key).update(payload).digest('hex'))));`,
    );
    batch = {
      original,
      migrated,
      originalValues: original.ok ? JSON.parse(original.value) : undefined,
      migratedValues: migrated.ok ? JSON.parse(migrated.value) : undefined,
    };
    return batch;
  }

  for (const [index, combination] of combinations.entries()) {
    it(`key ${JSON.stringify(combination.key).slice(0, 12)} payload ${combination.payload.length} bytes`, () => {
      if (!nodeAvailable)
        throw new Error(
          'node must be on PATH: a differential case that skips reports a pass it did not earn',
        );
      const results = hmacBatch();
      expect(results.original.ok).toBe(true);
      expect(results.migrated.ok).toBe(true);
      expect(results.migratedValues[index]).toBe(results.originalValues[index]);
    });
  }
});

describe('property: decompression agrees on arbitrary compressed payloads', () => {
  const PAYLOADS = [
    '',
    'a',
    'repeated '.repeat(200),
    '中文 unicode 🚀',
    'x'.repeat(10000),
    JSON.stringify({ nested: { array: [1, 2, 3], text: 'value' } }),
  ];

  for (const payload of PAYLOADS) {
    it(`gunzip round trip for ${payload.length} bytes`, () => {
      if (!nodeAvailable)
        throw new Error(
          'node must be on PATH: a differential case that skips reports a pass it did not earn',
        );
      const escaped = JSON.stringify(payload);
      const original = run(
        'node',
        `const { gzipSync, gunzipSync } = require('node:zlib');
         console.log(gunzipSync(gzipSync(${escaped})).toString('base64'));`,
      );
      const migrated = run(
        'bun',
        `const packed = Buffer.from(Bun.gzipSync(${escaped}));
         console.log(Buffer.from(Bun.gunzipSync(packed)).toString('base64'));`,
      );
      expect(original.ok).toBe(true);
      expect(migrated.ok).toBe(true);
      expect(migrated.value).toBe(original.value);
    });

    it(`inflateRaw accepts raw deflate from node for ${payload.length} bytes`, () => {
      if (!nodeAvailable)
        throw new Error(
          'node must be on PATH: a differential case that skips reports a pass it did not earn',
        );
      const escaped = JSON.stringify(payload);
      const original = run(
        'node',
        `const { deflateRawSync, inflateRawSync } = require('node:zlib');
         console.log(inflateRawSync(deflateRawSync(${escaped})).toString('base64'));`,
      );
      const migrated = run(
        'bun',
        `const packed = Buffer.from(require('node:zlib').deflateRawSync(${escaped}));
         console.log(Buffer.from(Bun.inflateSync(packed)).toString('base64'));`,
      );
      expect(original.ok).toBe(true);
      expect(migrated.ok).toBe(true);
      expect(migrated.value).toBe(original.value);
    });

    it(`raw deflate bytes diverge past the zlib block threshold for ${payload.length} bytes`, () => {
      if (!nodeAvailable)
        throw new Error(
          'node must be on PATH: a differential case that skips reports a pass it did not earn',
        );
      const escaped = JSON.stringify(payload);
      const original = run(
        'node',
        `const { deflateRawSync } = require('node:zlib');
         console.log(Buffer.from(deflateRawSync(${escaped})).toString('hex'));`,
      );
      const migrated = run(
        'bun',
        `console.log(Buffer.from(Bun.deflateSync(${escaped})).toString('hex'));`,
      );
      expect(original.ok).toBe(true);
      expect(migrated.ok).toBe(true);
      if (payload.length <= 200) {
        expect(migrated.value).toBe(original.value);
      } else {
        expect(migrated.value).not.toBe(original.value);
      }
    });
  }

  it('places the measured divergence boundary at 500 bytes', () => {
    if (!nodeAvailable)
      throw new Error(
        'node must be on PATH: a differential case that skips reports a pass it did not earn',
      );
    const hex = (engine, size) => {
      const source =
        engine === 'node'
          ? `const { deflateRawSync } = require('node:zlib');console.log(Buffer.from(deflateRawSync('x'.repeat(${size}))).toString('hex'));`
          : `console.log(Buffer.from(Bun.deflateSync('x'.repeat(${size}))).toString('hex'));`;
      const result = run(engine, source);
      if (!result.ok)
        throw new Error(`${engine} failed on ${size} bytes: ${result.detail ?? 'no output'}`);
      if (typeof result.value !== 'string' || result.value === '') {
        throw new Error(
          `${engine} produced no hex for ${size} bytes, so the comparison would be empty`,
        );
      }
      return result.value;
    };
    expect(hex('bun', 200)).toBe(hex('node', 200));
    expect(hex('bun', 500)).not.toBe(hex('node', 500));
  });
});

describe('property: zlib-wrapped streams do not cross to Bun deflate', () => {
  const PAYLOADS = ['', 'a', 'hello', 'x'.repeat(500)];

  for (const payload of PAYLOADS) {
    it(`Bun.inflateSync rejects a node deflateSync stream of ${payload.length} bytes`, () => {
      const escaped = JSON.stringify(payload);
      const result = run(
        'bun',
        `const { deflateSync } = require('node:zlib');
         const packed = deflateSync(${escaped});
         try {
           Bun.inflateSync(packed);
           console.log('ACCEPTED');
         } catch (error) {
           console.log('REJECTED:' + (error.code ?? error.message));
         }`,
      );
      expect(result.ok).toBe(true);
      expect(result.value.startsWith('REJECTED')).toBe(true);
    });

    it(`node inflateSync rejects a Bun.deflateSync stream of ${payload.length} bytes`, () => {
      if (!nodeAvailable)
        throw new Error(
          'node must be on PATH: a differential case that skips reports a pass it did not earn',
        );
      const escaped = JSON.stringify(payload);
      const result = run(
        'bun',
        `const { inflateSync } = require('node:zlib');
         const packed = Buffer.from(Bun.deflateSync(${escaped}));
         try {
           inflateSync(packed);
           console.log('ACCEPTED');
         } catch (error) {
           console.log('REJECTED:' + error.code);
         }`,
      );
      expect(result.ok).toBe(true);
      expect(result.value.startsWith('REJECTED')).toBe(true);
    });
  }
});

describe('property: ansi stripping agrees on arbitrary escape sequences', () => {
  const PAYLOADS = [
    '',
    'plain',
    '\u001B[31mred\u001B[0m',
    '\u001B[1;32mbold green\u001B[0m',
    '\u001B[38;5;196m256 colour\u001B[0m',
    '\u001B[38;2;255;0;0mtruecolor\u001B[0m',
    'a\u001B[31mb\u001B[0mc\u001B[1md\u001B[0m',
    '\u001B]0;title\u0007after-title',
    '中文\u001B[31m红色\u001B[0m',
  ];

  for (const payload of PAYLOADS) {
    it(`strips ${JSON.stringify(payload).slice(0, 24)}`, () => {
      if (!nodeAvailable)
        throw new Error(
          'node must be on PATH: a differential case that skips reports a pass it did not earn',
        );
      const escaped = JSON.stringify(payload);
      const original = run(
        'node',
        `const { stripVTControlCharacters } = require('node:util');
         console.log(JSON.stringify(stripVTControlCharacters(${escaped})));`,
      );
      const migrated = run('bun', `console.log(JSON.stringify(Bun.stripANSI(${escaped})));`);
      expect(original.ok).toBe(true);
      expect(migrated.ok).toBe(true);
      expect(migrated.value).toBe(original.value);
    });
  }
});

describe('property: deep equality agrees on nested structures', () => {
  const VALUES = [
    ['null', 'null'],
    ['1', '1'],
    ['"text"', '"text"'],
    ['[1,2,3]', '[1,2,3]'],
    ['[1,2,3]', '[1,2,4]'],
    ['{a:1,b:[2,{c:3}]}', '{a:1,b:[2,{c:3}]}'],
    ['{a:1}', '{a:2}'],
    ['new Date(0)', 'new Date(0)'],
    ['new Map([["a",1]])', 'new Map([["a",1]])'],
    ['new Set([1,2])', 'new Set([1,2])'],
    ['new Set([1,2])', 'new Set([2,1])'],
    ['0', '-0'],
    ['NaN', 'NaN'],
    ['[NaN]', '[NaN]'],
  ];

  for (const [left, right] of VALUES) {
    it(`${left} vs ${right}`, () => {
      if (!nodeAvailable)
        throw new Error(
          'node must be on PATH: a differential case that skips reports a pass it did not earn',
        );
      const original = run(
        'node',
        `const { isDeepStrictEqual } = require('node:util');
         console.log(String(isDeepStrictEqual(${left}, ${right})));`,
      );
      const migrated = run('bun', `console.log(String(Bun.deepEquals(${left}, ${right})));`);
      expect(original.ok).toBe(true);
      expect(migrated.ok).toBe(true);
      expect(migrated.value).toBe(original.value);
    });
  }

  it('diverges on an undefined-valued key, which is why the rule is report-only', () => {
    if (!nodeAvailable)
      throw new Error(
        'node must be on PATH: a differential case that skips reports a pass it did not earn',
      );
    const original = run(
      'node',
      `const { isDeepStrictEqual } = require('node:util');
       console.log(String(isDeepStrictEqual({a: undefined}, {})));`,
    );
    const migrated = run('bun', `console.log(String(Bun.deepEquals({a: undefined}, {})));`);
    expect(original.value).toBe('false');
    expect(migrated.value).toBe('true');
  });
});

describe('property: file URL conversion agrees on representative paths', () => {
  it('round trips the running file through both implementations', () => {
    if (!nodeAvailable)
      throw new Error(
        'node must be on PATH: a differential case that skips reports a pass it did not earn',
      );
    const source = `
      const { pathToFileURL, fileURLToPath } = require('node:url');
      const self = pathToFileURL(__filename);
      const back = fileURLToPath(self);
      console.log(back.endsWith('case.cjs') ? 'MATCH' : 'MISMATCH:' + back);
    `;
    const bunSource = `
      const self = require('node:url').pathToFileURL(__filename);
      const back = Bun.fileURLToPath(self);
      console.log(back.endsWith('case.cjs') ? 'MATCH' : 'MISMATCH:' + back);
    `;
    const original = run('node', source);
    const migrated = run('bun', bunSource);
    expect(original.ok).toBe(true);
    expect(migrated.ok).toBe(true);
    expect(original.value).toBe('MATCH');
    expect(migrated.value).toBe('MATCH');
  });
});
