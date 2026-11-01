/**
 * Constants with the same name and a different value.
 *
 * The assertions run both runtimes, so a Bun that aligns a value makes the test
 * say so rather than leaving a stale claim in the table.
 */
import { describe, expect, it } from 'bun:test';

import { CONSTANT_VALUE_DIFFERENCES, constantDifferencesFor } from '../src/constant-values.mjs';

const nodeAvailable = (() => Bun.spawnSync(['node', '--version']).exitCode === 0)();

function nodeValue(moduleName, path) {
  const script = `
    const m = require(${JSON.stringify(moduleName)});
    const parts = ${JSON.stringify(path)}.split('.');
    let v = m;
    for (const p of parts) v = v?.[p];
    process.stdout.write(String(v));
  `;
  const result = Bun.spawnSync(['node', '-e', script]);
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

/**
 * Read several values in one Node process.
 *
 * Reading one value per spawn made the 13-flag TLS assertion take two seconds:
 * the constants are already loaded in Node, and the cost was entirely process
 * startup. One process returns the whole map.
 */
function nodeValues(moduleName, paths) {
  const script = `
    const m = require(${JSON.stringify(moduleName)});
    const out = {};
    for (const path of ${JSON.stringify(paths)}) {
      const parts = path.split('.');
      let v = m;
      for (const p of parts) v = v?.[p];
      out[path] = v === undefined ? null : String(v);
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const result = Bun.spawnSync(['node', '-e', script]);
  if (result.exitCode !== 0) return {};
  try {
    return JSON.parse(result.stdout.toString());
  } catch {
    return {};
  }
}

describe('table invariants', () => {
  it('every entry states both values, an impact and a workaround', () => {
    for (const entry of CONSTANT_VALUE_DIFFERENCES) {
      expect(entry.node.length).toBeGreaterThan(0);
      expect(entry.bun.length).toBeGreaterThan(0);
      expect(entry.impact.length).toBeGreaterThan(30);
      expect(entry.workaround.length).toBeGreaterThan(10);
      expect(entry.severity).toBe('silent');
    }
  });

  it('looks up by module', () => {
    expect(constantDifferencesFor('node:buffer').length).toBe(2);
    expect(constantDifferencesFor('node:crypto').length).toBe(2);
    expect(constantDifferencesFor('node:fs').length).toBe(0);
  });
});

describe('buffer limits differ by orders of magnitude', () => {
  it('MAX_LENGTH is 8 PB on Node and 4 GB on Bun', () => {
    if (!nodeAvailable)
      throw new Error(
        'node must be on PATH: every differential case compares two runtimes, so skipping it would report a pass that proves nothing',
      );
    expect(nodeValue('node:buffer', 'constants.MAX_LENGTH')).toBe('9007199254740991');
    expect(String(require('node:buffer').constants.MAX_LENGTH)).toBe('4294967296');
  });

  it('MAX_STRING_LENGTH differs between the two', () => {
    if (!nodeAvailable)
      throw new Error(
        'node must be on PATH: every differential case compares two runtimes, so skipping it would report a pass that proves nothing',
      );
    const nodeLimit = Number(nodeValue('node:buffer', 'constants.MAX_STRING_LENGTH'));
    const bunLimit = require('node:buffer').constants.MAX_STRING_LENGTH;
    expect(nodeLimit).not.toBe(bunLimit);
    expect(bunLimit).toBe(2147483647);
  });

  it('a size guard written against MAX_LENGTH changes threshold', () => {
    const bunLimit = require('node:buffer').constants.MAX_LENGTH;
    const fiveGb = 5 * 1024 ** 3;
    expect(fiveGb > bunLimit).toBe(true);
    expect(fiveGb > 9007199254740991).toBe(false);
  });
});

describe('TLS option flags are zero, so OR-ing them is a no-op', () => {
  const FLAGS = [
    'SSL_OP_NO_COMPRESSION',
    'SSL_OP_NO_RENEGOTIATION',
    'SSL_OP_NO_SSLv3',
    'SSL_OP_PRIORITIZE_CHACHA',
    'SSL_OP_ALLOW_NO_DHE_KEX',
    'SSL_OP_NO_ENCRYPT_THEN_MAC',
    'SSL_OP_TLS_ROLLBACK_BUG',
    'SSL_OP_CISCO_ANYCONNECT',
    'SSL_OP_COOKIE_EXCHANGE',
    'SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS',
    'SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION',
    'SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION',
    'SSL_OP_CRYPTOPRO_TLSEXT_BUG',
  ];

  for (const flag of FLAGS) {
    it(`${flag} is zero on Bun`, () => {
      expect(`${flag}=${require('node:crypto').constants[flag]}`).toBe(`${flag}=0`);
    });
  }

  it('SSL_OP_ALL is 4 on Bun and a wide mask on Node', () => {
    if (!nodeAvailable)
      throw new Error(
        'node must be on PATH: every differential case compares two runtimes, so skipping it would report a pass that proves nothing',
      );
    expect(require('node:crypto').constants.SSL_OP_ALL).toBe(4);
    expect(Number(nodeValue('node:crypto', 'constants.SSL_OP_ALL'))).toBe(2147485776);
  });

  it('the same flags are non-zero on Node', () => {
    if (!nodeAvailable)
      throw new Error(
        'node must be on PATH: every differential case compares two runtimes, so skipping it would report a pass that proves nothing',
      );
    const values = nodeValues(
      'node:crypto',
      FLAGS.map((flag) => `constants.${flag}`),
    );
    let nonZero = 0;
    for (const flag of FLAGS) {
      const value = Number(values[`constants.${flag}`]);
      if (Number.isFinite(value) && value !== 0) nonZero += 1;
    }
    expect(nonZero).toBeGreaterThan(0);
  });

  it('OR-ing a zero flag leaves the options word unchanged', () => {
    const flags = require('node:crypto').constants;
    let options = 0;
    options |= flags.SSL_OP_NO_COMPRESSION;
    options |= flags.SSL_OP_NO_RENEGOTIATION;
    expect(options).toBe(0);
  });
});

describe('OpenSSL version reports a different build', () => {
  it('differs between the two runtimes', () => {
    if (!nodeAvailable)
      throw new Error(
        'node must be on PATH: every differential case compares two runtimes, so skipping it would report a pass that proves nothing',
      );
    const nodeVersion = Number(nodeValue('node:crypto', 'constants.OPENSSL_VERSION_NUMBER'));
    const bunVersion = require('node:crypto').constants.OPENSSL_VERSION_NUMBER;
    expect(nodeVersion).not.toBe(bunVersion);
    expect(bunVersion).toBe(269488255);
  });
});

describe('the enumeration is reproducible', () => {
  it('produces parseable constant reports for both runtimes', () => {
    const script = `${import.meta.dir}/../src/enumerate-constants.mjs`;
    const parse = (buffer) => JSON.parse(buffer.toString().trim().split('\n')[0]);
    const nodeReport = parse(Bun.spawnSync(['node', script, 'node']).stdout);
    const bunReport = parse(Bun.spawnSync(['bun', script, 'bun']).stdout);
    expect(Object.keys(nodeReport.values).length).toBeGreaterThan(5);
    expect(Object.keys(bunReport.values).length).toBeGreaterThan(5);
    expect(Object.keys(nodeReport.values).length).toBe(Object.keys(bunReport.values).length);
  });
});
