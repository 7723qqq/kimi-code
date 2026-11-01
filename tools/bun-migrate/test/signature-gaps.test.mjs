/**
 * Arity differences: the fourth class, and the one that is mostly noise.
 *
 * The interesting assertion here is not that the curated entries differ — it is
 * that the large tail of differences does NOT affect calling the function. The
 * suite proves both, so the table can stay small without pretending the rest
 * does not exist.
 */
import { describe, expect, it } from 'bun:test';

import { SIGNATURE_DIFF_SUMMARY, SIGNATURE_GAPS, signatureGapFor } from '../src/signature-gaps.mjs';

const nodeAvailable = (() => Bun.spawnSync(['node', '--version']).exitCode === 0)();

function nodeLength(moduleName, member) {
  const script = `
    const m = require(${JSON.stringify(moduleName)});
    process.stdout.write(String(m[${JSON.stringify(member)}].length));
  `;
  const result = Bun.spawnSync(['node', '-e', script]);
  return result.exitCode === 0 ? Number(result.stdout.toString()) : undefined;
}

function bunLength(moduleName, member) {
  const loaded = require(moduleName);
  return loaded[member].length;
}

describe('table invariants', () => {
  it('every entry states both signatures, an impact and a workaround', () => {
    for (const gap of SIGNATURE_GAPS) {
      expect(typeof gap.node.length).toBe('number');
      expect(typeof gap.bun.length).toBe('number');
      expect(gap.node.name.length).toBeGreaterThan(0);
      expect(gap.bun.name.length).toBeGreaterThan(0);
      expect(gap.impact.length).toBeGreaterThan(30);
      expect(gap.workaround.length).toBeGreaterThan(10);
      expect(gap.severity).toBe('silent');
    }
  });

  it('no entry claims a signature that matches', () => {
    for (const gap of SIGNATURE_GAPS) {
      expect(
        `${gap.member} node=${gap.node.length} bun=${gap.bun.length} differs=${gap.node.length !== gap.bun.length}`,
      ).toBe(`${gap.member} node=${gap.node.length} bun=${gap.bun.length} differs=true`);
    }
  });

  it('looks up by module and member', () => {
    expect(signatureGapFor('node:crypto', 'scrypt')).toBeDefined();
    expect(signatureGapFor('node:crypto', 'nonexistent')).toBeUndefined();
  });
});

describe('the recorded arities match live runtimes', () => {
  for (const gap of SIGNATURE_GAPS) {
    it(`${gap.module}#${gap.member}`, () => {
      if (!nodeAvailable)
        throw new Error(
          'node must be on PATH: every differential case compares two runtimes, so skipping it would report a pass that proves nothing',
        );
      expect(`${gap.member} bun=${bunLength(gap.module, gap.member)}`).toBe(
        `${gap.member} bun=${gap.bun.length}`,
      );
      expect(`${gap.member} node=${nodeLength(gap.module, gap.member)}`).toBe(
        `${gap.member} node=${gap.node.length}`,
      );
    });
  }
});

describe('promisify reads the arity, which is why the table exists', () => {
  it('a promisified function keeps the source arity', () => {
    const { promisify } = require('node:util');
    const threeArgs = (a, b, cb) => cb(null, a + b);
    expect(promisify(threeArgs).length).toBe(3);
  });

  it('promisifying crypto.scrypt gives different arities on the two runtimes', () => {
    if (!nodeAvailable)
      throw new Error(
        'node must be on PATH: every differential case compares two runtimes, so skipping it would report a pass that proves nothing',
      );
    const script = `
      const { promisify } = require('node:util');
      const crypto = require('node:crypto');
      process.stdout.write(String(promisify(crypto.scrypt).length));
    `;
    const nodeArity = Bun.spawnSync(['node', '-e', script]).stdout.toString();
    const bunArity = require('node:util').promisify(require('node:crypto').scrypt).length;
    expect(`${nodeArity}`).toBe(String(SIGNATURE_GAPS[0].node.length));
    expect(String(bunArity)).toBe(String(SIGNATURE_GAPS[0].bun.length));
    expect(nodeArity).not.toBe(String(bunArity));
  });
});

describe('most of the raw diff does not affect calling the function', () => {
  it('fs.promises functions still accept their documented arguments', async () => {
    const fsp = require('node:fs/promises');
    const os = require('node:os');
    const entries = await fsp.readdir(os.tmpdir());
    expect(Array.isArray(entries)).toBe(true);

    const target = `${os.tmpdir()}/bun-migrate-arity-${Date.now()}.txt`;
    await fsp.writeFile(target, 'probe', 'utf8');
    expect(await fsp.readFile(target, 'utf8')).toBe('probe');
    const info = await fsp.stat(target);
    expect(info.size).toBe(5);
    await fsp.unlink(target).catch(() => {});
  });

  it('the rest-argument wrapper is visible in the source text', () => {
    const fsp = require('node:fs/promises');
    const source = fsp.readdir.toString();
    expect(source.includes('...args')).toBe(true);
  });

  it('the summary states how the diff splits', () => {
    const summary = SIGNATURE_DIFF_SUMMARY;
    expect(summary.totalArityDifferences).toBeGreaterThan(summary.curatedEntries);
    expect(
      summary.bunDeclaresMoreParams + summary.nodeDeclaresNone + summary.nodeDeclaresMoreParams,
    ).toBeGreaterThanOrEqual(summary.totalArityDifferences);
    expect(summary.reason).toContain('rest-argument wrapper');
  });
});

describe('the enumeration is reproducible', () => {
  it('produces parseable signature reports for both runtimes', () => {
    const script = `${import.meta.dir}/../src/enumerate-signatures.mjs`;
    const parse = (buffer) => JSON.parse(buffer.toString().trim().split('\n')[0]);
    const nodeReport = parse(Bun.spawnSync(['node', script, 'node']).stdout);
    const bunReport = parse(Bun.spawnSync(['bun', script, 'bun']).stdout);
    expect(Object.keys(nodeReport.modules).length).toBeGreaterThan(30);
    expect(Object.keys(nodeReport.modules).length).toBe(Object.keys(bunReport.modules).length);
    const crypto = nodeReport.modules['node:crypto'];
    expect(crypto.functions.scrypt.length).toBe(4);
    const bunCrypto = bunReport.modules['node:crypto'];
    expect(bunCrypto.functions.scrypt.length).toBe(5);
  });
});
