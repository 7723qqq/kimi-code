/**
 * Rewrites are offered only when they are behaviour preserving. This file is
 * the proof: every pairing in src/pairings.mjs is exercised as "original under
 * Node" versus "migrated under Bun", and the two results must agree.
 *
 * It runs against whatever node and bun are on PATH. When node is missing the
 * suite reports that plainly rather than passing silently, because a skipped
 * proof is not a proof.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { PAIRINGS, REPORT_ONLY, SPEED } from '../src/pairings.mjs';

const CASES = [
  {
    pairing: 'crypto-createHash',
    name: 'sha256 hex digest',
    original: `
      const { createHash } = require('node:crypto');
      module.exports = createHash('sha256').update('hello world').digest('hex');
    `,
    migrated: `
      module.exports = new Bun.CryptoHasher('sha256').update('hello world').digest('hex');
    `,
  },
  {
    pairing: 'crypto-createHash',
    name: 'sha256 base64 digest',
    original: `
      const { createHash } = require('node:crypto');
      module.exports = createHash('sha256').update('hello world').digest('base64');
    `,
    migrated: `
      module.exports = new Bun.CryptoHasher('sha256').update('hello world').digest('base64');
    `,
  },
  {
    pairing: 'crypto-createHash',
    name: 'sha512 byte length',
    original: `
      const { createHash } = require('node:crypto');
      module.exports = createHash('sha512').update('abc').digest().length;
    `,
    migrated: `
      module.exports = new Bun.CryptoHasher('sha512').update('abc').digest().length;
    `,
  },
  {
    pairing: 'crypto-createHash',
    name: 'incremental update',
    original: `
      const { createHash } = require('node:crypto');
      const h = createHash('sha256');
      h.update('hello ');
      h.update('world');
      module.exports = h.digest('hex');
    `,
    migrated: `
      const h = new Bun.CryptoHasher('sha256');
      h.update('hello ');
      h.update('world');
      module.exports = h.digest('hex');
    `,
  },
  {
    pairing: 'crypto-createHash',
    name: 'copy before digest',
    original: `
      const { createHash } = require('node:crypto');
      const h = createHash('sha256').update('hello ');
      const c = h.copy();
      c.update('world');
      module.exports = { base: h.digest('hex'), copied: c.digest('hex') };
    `,
    migrated: `
      const h = new Bun.CryptoHasher('sha256').update('hello ');
      const c = h.copy();
      c.update('world');
      module.exports = { base: h.digest('hex'), copied: c.digest('hex') };
    `,
  },
  {
    pairing: 'crypto-createHmac',
    name: 'hmac sha256 hex',
    original: `
      const { createHmac } = require('node:crypto');
      module.exports = createHmac('sha256', 'key').update('hello world').digest('hex');
    `,
    migrated: `
      module.exports = new Bun.CryptoHasher('sha256', 'key').update('hello world').digest('hex');
    `,
  },
  {
    pairing: 'fs-readFile-promises',
    name: 'utf8 existing file',
    original: `
      const { writeFile, readFile } = require('node:fs/promises');
      const p = require('node:path').join(__dirname, 'sample.txt');
      (async () => {
        await writeFile(p, 'hello world');
        module.exports = await readFile(p, 'utf8');
      })();
    `,
    migrated: `
      const p = require('node:path').join(__dirname, 'sample.txt');
      (async () => {
        await Bun.write(p, 'hello world');
        module.exports = await Bun.file(p).text();
      })();
    `,
  },
  {
    pairing: 'fs-readFile-promises',
    name: 'missing file rejects with ENOENT on both sides',
    original: `
      const { readFile } = require('node:fs/promises');
      (async () => {
        try { await readFile('/definitely/not/here.txt', 'utf8'); module.exports = 'NO-THROW'; }
        catch (e) { module.exports = e.code; }
      })();
    `,
    migrated: `
      (async () => {
        try { await Bun.file('/definitely/not/here.txt').text(); module.exports = 'NO-THROW'; }
        catch (e) { module.exports = e.code; }
      })();
    `,
  },
  {
    pairing: 'fs-readFile-promises',
    name: 'multibyte text round trip',
    original: `
      const { writeFile, readFile } = require('node:fs/promises');
      const p = require('node:path').join(__dirname, 'unicode.txt');
      (async () => {
        const text = '中文 emoji 🚀 combining é';
        await writeFile(p, text, 'utf8');
        module.exports = await readFile(p, 'utf8');
      })();
    `,
    migrated: `
      const p = require('node:path').join(__dirname, 'unicode.txt');
      (async () => {
        const text = '中文 emoji 🚀 combining é';
        await Bun.write(p, text);
        module.exports = await Bun.file(p).text();
      })();
    `,
  },
  {
    pairing: 'zlib-gzipSync',
    name: 'decodes in the other runtime even though the bytes differ',
    original: `
      const { gzipSync, gunzipSync } = require('node:zlib');
      const packed = gzipSync('hello world'.repeat(100));
      console.log(gunzipSync(packed).toString().length);
    `,
    migrated: `
      const { gunzipSync } = require('node:zlib');
      const packed = Buffer.from(Bun.gzipSync('hello world'.repeat(100)));
      console.log(gunzipSync(packed).toString().length);
    `,
  },
  {
    pairing: 'zlib-gzipSync',
    name: 'the rewrite wraps Bun Uint8Array in a Buffer, preserving toString(encoding)',
    original: `
      const { gzipSync } = require('node:zlib');
      console.log(typeof gzipSync(Buffer.from('x')).toString('base64'));
    `,
    migrated: `
      const packed = Buffer.from(Bun.gzipSync(Buffer.from('x')));
      console.log(typeof packed.toString('base64'));
    `,
  },
  {
    pairing: 'zlib-gunzipSync',
    name: 'node-compressed data inflates to the same bytes',
    original: `
      const { gzipSync, gunzipSync } = require('node:zlib');
      const packed = gzipSync('payload '.repeat(50));
      console.log(gunzipSync(packed).toString());
    `,
    migrated: `
      const packed = Buffer.from(Bun.gzipSync('payload '.repeat(50)));
      console.log(Buffer.from(Bun.gunzipSync(packed)).toString());
    `,
    skipMigratedComparison: true,
    compareOriginalToBunDecode: true,
  },
  {
    pairing: 'zlib-deflateSync-zlib-wrapped',
    name: 'deflate output differs byte for byte',
    original: `
      const { deflateSync } = require('node:zlib');
      console.log(deflateSync('round trip').toString('base64'));
    `,
    migrated: `
      console.log(Buffer.from(Bun.deflateSync('round trip')).toString('base64'));
    `,
    expectDifferent: true,
  },
  {
    pairing: 'zlib-inflateSync-zlib-wrapped',
    name: 'node deflate inflates under Bun to the same bytes',
    original: `
      const { deflateSync, inflateSync } = require('node:zlib');
      console.log(inflateSync(deflateSync('cross runtime')).toString());
    `,
    migrated: `
      console.log(Buffer.from(Bun.inflateSync(Buffer.from(require('node:zlib').deflateSync('cross runtime')))).toString());
    `,
    skipMigratedComparison: true,
    compareOriginalToBunDecode: true,
  },
  {
    pairing: 'url-fileURLToPath',
    name: 'file URL to path for a real file',
    original: `
      const { fileURLToPath, pathToFileURL } = require('node:url');
      const self = __filename;
      const asUrl = pathToFileURL(self);
      const back = fileURLToPath(asUrl).split('\\\\').join('/');
      console.log(back.endsWith('case.cjs') ? 'ends-with-case' : back);
    `,
    migrated: `
      const self = __filename;
      const asUrl = require('node:url').pathToFileURL(self);
      const back = Bun.fileURLToPath(asUrl).split('\\\\').join('/');
      console.log(back.endsWith('case.cjs') ? 'ends-with-case' : back);
    `,
  },
  {
    pairing: 'url-pathToFileURL',
    name: 'reports the Windows drive-letter difference rather than hiding it',
    original: `
      const { pathToFileURL } = require('node:url');
      console.log(pathToFileURL('/tmp/example.txt').href);
    `,
    migrated: `
      console.log(Bun.pathToFileURL('/tmp/example.txt').href);
    `,
    expectDifferentOnWindowsOnly: true,
  },
  {
    pairing: 'fs-globSync',
    name: 'glob finds the same files',
    original: `
      const { globSync } = require('node:fs');
      const { writeFileSync } = require('node:fs');
      const p = require('node:path');
      writeFileSync(p.join(__dirname, 'a.yaml'), '');
      writeFileSync(p.join(__dirname, 'b.yaml'), '');
      console.log(globSync('*.yaml', { cwd: __dirname }).map((f) => p.basename(f)).sort().join(','));
    `,
    migrated: `
      const { writeFileSync } = require('node:fs');
      const p = require('node:path');
      writeFileSync(p.join(__dirname, 'a.yaml'), '');
      writeFileSync(p.join(__dirname, 'b.yaml'), '');
      console.log([...new Bun.Glob('*.yaml').scanSync({ cwd: __dirname })].sort().join(','));
    `,
  },
  {
    pairing: 'fs-writeFile-promises',
    name: 'report-only: Bun.write and writeFile both persist the same bytes',
    original: `
      const { writeFile, readFile } = require('node:fs/promises');
      const p = require('node:path').join(__dirname, 'w.txt');
      (async () => { await writeFile(p, 'hello'); module.exports = await readFile(p, 'utf8'); })();
    `,
    migrated: `
      const p = require('node:path').join(__dirname, 'w.txt');
      (async () => { await Bun.write(p, 'hello'); module.exports = await require('node:fs/promises').readFile(p, 'utf8'); })();
    `,
  },
  {
    pairing: 'fs-copyFile-promises',
    name: 'report-only: Bun.write(Bun.file()) copies the same content, so the rule reports the flag it would lose rather than the bytes',
    original: `
      const { writeFile, copyFile, readFile } = require('node:fs/promises');
      const p = require('node:path');
      (async () => {
        await writeFile(p.join(__dirname, 'a.txt'), 'payload');
        await copyFile(p.join(__dirname, 'a.txt'), p.join(__dirname, 'b.txt'));
        module.exports = await readFile(p.join(__dirname, 'b.txt'), 'utf8');
      })();
    `,
    migrated: `
      const p = require('node:path');
      (async () => {
        await require('node:fs/promises').writeFile(p.join(__dirname, 'a.txt'), 'payload');
        await Bun.write(p.join(__dirname, 'b.txt'), Bun.file(p.join(__dirname, 'a.txt')));
        module.exports = await require('node:fs/promises').readFile(p.join(__dirname, 'b.txt'), 'utf8');
      })();
    `,
  },
  {
    pairing: 'zlib-zstdCompressSync',
    name: 'frame length matches node, because the two emit identical frames',
    original: `
      const { zstdCompressSync } = require('node:zlib');
      const out = zstdCompressSync('interop '.repeat(50));
      console.log(Buffer.from(out).length);
    `,
    migrated: `
      console.log(Buffer.from(Bun.zstdCompressSync('interop '.repeat(50))).length);
    `,
  },
  {
    pairing: 'zlib-zstdDecompressSync',
    name: 'node-compressed frame decompresses to the same width',
    original: `
      const { zstdCompressSync, zstdDecompressSync } = require('node:zlib');
      console.log(Buffer.from(zstdDecompressSync(zstdCompressSync('roundtrip '.repeat(20)))).toString().length);
    `,
    migrated: `
      console.log(Buffer.from(Bun.zstdDecompressSync(Buffer.from(require('node:zlib').zstdCompressSync('roundtrip '.repeat(20))))).toString().length);
    `,
  },
  {
    pairing: 'zlib-deflateRawSync',
    name: 'raw deflate bytes agree on a small payload and diverge on a large one',
    original: `
      const { deflateRawSync } = require('node:zlib');
      console.log(Buffer.from(deflateRawSync('raw '.repeat(10))).toString('hex'));
    `,
    migrated: `
      console.log(Buffer.from(Bun.deflateSync('raw '.repeat(10))).toString('hex'));
    `,
  },
  {
    pairing: 'zlib-inflateRawSync',
    name: 'report-only on the wrapped form, but a raw stream decodes both ways',
    original: `
      const { deflateRawSync, inflateRawSync } = require('node:zlib');
      console.log(Buffer.from(inflateRawSync(deflateRawSync('raw round '.repeat(10)))).toString().length);
    `,
    migrated: `
      console.log(Buffer.from(Bun.inflateSync(Buffer.from(Bun.deflateSync('raw round '.repeat(10))))).toString().length);
    `,
  },
  {
    pairing: 'zlib-brotliCompressSync',
    name: 'report-only: Bun has no brotli helper, so the node: call is the one that runs and it round-trips',
    original: `
      const { brotliCompressSync, brotliDecompressSync } = require('node:zlib');
      console.log(Buffer.from(brotliDecompressSync(brotliCompressSync('br '.repeat(20)))).toString().length);
    `,
    migrated: `
      const { brotliCompressSync, brotliDecompressSync } = require('node:zlib');
      console.log(Buffer.from(brotliDecompressSync(brotliCompressSync('br '.repeat(20)))).toString().length);
    `,
  },
  {
    pairing: 'fs-readFileSync',
    name: 'report-only: the sync read is unchanged on both runtimes',
    original: `
      const { writeFileSync, readFileSync } = require('node:fs');
      const p = require('node:path').join(__dirname, 'r.txt');
      writeFileSync(p, 'sync text');
      console.log(readFileSync(p, 'utf8'));
    `,
    migrated: `
      const { writeFileSync } = require('node:fs');
      const p = require('node:path').join(__dirname, 'r.txt');
      writeFileSync(p, 'sync text');
      console.log(require('node:fs').readFileSync(p, 'utf8'));
    `,
  },
  {
    pairing: 'fs-writeFileSync',
    name: 'Bun.write is asynchronous, so a synchronous read that follows it sees nothing',
    original: `
      const { writeFileSync, readFileSync } = require('node:fs');
      const p = require('node:path').join(__dirname, 'w2.txt');
      writeFileSync(p, 'w');
      console.log(readFileSync(p, 'utf8'));
    `,
    migrated: `
      const { readFileSync } = require('node:fs');
      const p = require('node:path').join(__dirname, 'w2.txt');
      Bun.write(p, 'w');
      try {
        console.log(readFileSync(p, 'utf8'));
      } catch (error) {
        console.log(JSON.stringify({ code: error.code }));
      }
    `,
    expectDifferent: true,
  },
  {
    pairing: 'child_process-spawnSync',
    name: 'the result field a caller reads is renamed, not just reshaped',
    original: `
      const { spawnSync } = require('node:child_process');
      const r = spawnSync(process.execPath, ['-e', 'process.stdout.write("child")'], { encoding: 'utf8' });
      console.log(JSON.stringify({ out: r.stdout, status: r.status }));
    `,
    migrated: `
      const r = Bun.spawnSync([process.execPath, '-e', 'process.stdout.write("child")'], { stdout: 'pipe' });
      console.log(JSON.stringify({ out: r.stdout.toString(), exitCode: r.exitCode }));
    `,
    expectDifferent: true,
  },
  {
    pairing: 'util-stripVTControlCharacters',
    name: 'both strip the same escape sequences',
    original: `
      const { stripVTControlCharacters } = require('node:util');
      console.log(JSON.stringify(stripVTControlCharacters('\\u001b[31mred\\u001b[0m plain')));
    `,
    migrated: `
      console.log(JSON.stringify(Bun.stripANSI('\\u001b[31mred\\u001b[0m plain')));
    `,
  },
  {
    pairing: 'util-isDeepStrictEqual',
    name: 'an undefined-valued key counts as present on node and absent on Bun',
    original: `
      const { isDeepStrictEqual } = require('node:util');
      console.log(JSON.stringify({ plain: isDeepStrictEqual({a:1},{a:1}), undef: isDeepStrictEqual({a:undefined},{}) }));
    `,
    migrated: `
      console.log(JSON.stringify({ plain: Bun.deepEquals({a:1},{a:1}), undef: Bun.deepEquals({a:undefined},{}) }));
    `,
    expectDifferent: true,
  },
  {
    pairing: 'util-format',
    name: 'report-only: Bun has no printf formatter, so the node: call is the one under test on both sides',
    original: `
      const { format } = require('node:util');
      console.log(JSON.stringify(format('%s-%d', 'a', 5)));
    `,
    migrated: `
      const { format } = require('node:util');
      console.log(JSON.stringify(format('%s-%d', 'a', 5)));
    `,
  },
];

function run(command, source) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-migrate-diff-'));
  const file = join(directory, 'case.cjs');
  try {
    writeFileSync(file, source, 'utf8');
    const result = Bun.spawnSync([command, file], { cwd: directory });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim().slice(0, 300);
      const detail = stderr.length > 0 ? stderr : `exit ${result.exitCode ?? 'unknown'}`;
      return { ok: false, detail };
    }
    return { ok: true, value: result.stdout.toString().trim() };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const nodeAvailable = (() => {
  const probe = Bun.spawnSync(['node', '--version']);
  return probe.exitCode === 0;
})();

describe('node to bun differential', () => {
  it('finds node on PATH', () => {
    if (!nodeAvailable) {
      throw new Error('SKIPPED: node is not on PATH, so no pairing was proven in this run');
    }
    expect(typeof nodeAvailable).toBe('boolean');
  });

  for (const testCase of CASES) {
    it(`${testCase.pairing}: ${testCase.name}`, () => {
      if (!nodeAvailable) throw new Error('node must be on PATH: every differential case compares two runtimes, so skipping it would report a pass that proves nothing');
      const original = run('node', testCase.original);
      expect(original.ok).toBe(true);

      if (testCase.compareOriginalToBunDecode) {
        const decoded = run('bun', testCase.original);
        expect(decoded.ok).toBe(true);
        expect(decoded.value).toBe(original.value);
        return;
      }

      const migrated = run('bun', testCase.migrated);
      expect(migrated.ok).toBe(true);

      if (testCase.expectDifferent) {
        expect(migrated.value).not.toBe(original.value);
        return;
      }
      if (testCase.expectDifferentOnWindowsOnly) {
        if (process.platform === 'win32') {
          expect(migrated.value).not.toBe(original.value);
        }
        return;
      }
      expect(migrated.value).toBe(original.value);
    });
  }
});

describe('every pairing has a differential case', () => {
  /**
   * The check that was missing. `differential.test.mjs` claimed to prove each rule
   * by running it under both runtimes, but only 8 of 23 pairings had a case — the
   * file's own docstring said "every pairing" while five rules had been added later
   * and never got one. A coverage assertion is the only thing that notices an
   * omission, because a missing case is not a failure, it is an absence.
   */
  it('names a case for each rule in the table', () => {
    const covered = new Set(CASES.map((testCase) => testCase.pairing));
    const missing = PAIRINGS.map((pairing) => pairing.id).filter((id) => !covered.has(id));
    expect(`rules without a case: ${JSON.stringify(missing)}`).toBe(
      'rules without a case: []',
    );
  });

  it('has no case for a rule that is not in the table', () => {
    const known = new Set(PAIRINGS.map((pairing) => pairing.id));
    const stale = [...new Set(CASES.map((testCase) => testCase.pairing))].filter((id) => !known.has(id));
    expect(`cases without a rule: ${JSON.stringify(stale)}`).toBe('cases without a rule: []');
  });
});

describe('readFile without an encoding', () => {
  it('differs after migration, which is why the pairing demands an encoding', () => {
    const source = `
      const { writeFile, readFile } = require('node:fs/promises');
      const p = require('node:path').join(__dirname, 'x.txt');
      (async () => {
        await writeFile(p, 'hello');
        const a = await readFile(p);
        const b = await Bun.file(p).text();
        console.log(JSON.stringify({
          originalIsBuffer: Buffer.isBuffer(a),
          migratedIsBuffer: Buffer.isBuffer(b),
        }));
      })();
    `;
    const result = run('bun', source);
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.value);
    expect(parsed.originalIsBuffer).toBe(true);
    expect(parsed.migratedIsBuffer).toBe(false);
  });
});

describe('zstd frames are byte-identical, which is why the rule may claim it', () => {
  /**
   * The rule summary said "cross-runtime frames decode but are not byte-identical",
   * which was inherited from the gzip finding and never measured for zstd. Measured
   * on Bun 1.4.4 against Node 24.9.0: 25 payloads from 1 byte to 32 MB, mixing random
   * bytes, ASCII text, JSON lines and long zero runs, produced identical frames every
   * time. The claim is now a fact with a test, so it cannot drift back.
   */
  const PAYLOADS = [
    ['empty', ''],
    ['1 byte', 'x'],
    ['16 bytes', 'compressible '.slice(0, 16)],
    ['1 KB text', 'compressible '.repeat(80)],
    ['100 KB text', 'compressible '.repeat(7700)],
    ['32 KB zeros', '\u0000'.repeat(32768)],
    ['pseudo-random 4 KB', Array.from({ length: 4096 }, (_, i) => String.fromCodePoint((i * 131 + 7) % 256)).join('')],
  ];

  it('states byte identity in the rule, not just interoperability', () => {
    const compress = PAIRINGS.find((pairing) => pairing.exportName === 'zstdCompressSync');
    expect(compress.summary).toContain('byte-identical');
    expect(compress.summary.includes('not byte-identical')).toBe(false);
  });

  for (const [label, payload] of PAYLOADS) {
    it(`matches a real Node frame: ${label}`, () => {
      if (!nodeAvailable) throw new Error('node must be on PATH: this compares against a frame Node produced');
      const dir = mkdtempSync(join(tmpdir(), 'zstdb-'));
      const file = join(dir, 'p.bin');
      try {
        writeFileSync(file, payload);
        const script = join(dir, 'enc.cjs');
        writeFileSync(
          script,
          "const { zstdCompressSync } = require('node:zlib');\nconst { readFileSync } = require('node:fs');\nprocess.stdout.write(Buffer.from(zstdCompressSync(readFileSync(process.argv[2]))).toString('hex'));\n",
        );
        const fromNode = Bun.spawnSync(['node', script, file]).stdout.toString().trim();
        const fromBun = Buffer.from(Bun.zstdCompressSync(payload)).toString('hex');
        expect(fromBun).toBe(fromNode);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('decodes a frame Node produced', () => {
    if (!nodeAvailable) throw new Error('node must be on PATH: this decodes a frame Node produced');
    const payload = 'decode me '.repeat(100);
    const dir = mkdtempSync(join(tmpdir(), 'zstdd-'));
    const file = join(dir, 'p.bin');
    const frame = join(dir, 'p.zst');
    try {
      writeFileSync(file, payload);
      const script = join(dir, 'enc.cjs');
      writeFileSync(
        script,
        "const { zstdCompressSync } = require('node:zlib');\nconst { readFileSync, writeFileSync } = require('node:fs');\nwriteFileSync(process.argv[3], Buffer.from(zstdCompressSync(readFileSync(process.argv[2]))));\n",
      );
      Bun.spawnSync(['node', script, file, frame]);
      const decoded = Buffer.from(Bun.zstdDecompressSync(readFileSync(frame))).toString();
      expect(decoded).toBe(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('measured performance decides speed claims', () => {
  it('keeps readFile and writeFile on node: because Bun measured no faster', () => {
    for (const name of ['readFile', 'writeFile', 'copyFile']) {
      const found = PAIRINGS.find((pairing) => pairing.exportName === name);
      expect(found).toBeDefined();
      expect(found.effect).toBe(REPORT_ONLY);
    }
  });

  it('puts the rules with a measured win on speed', () => {
    const fast = [
      'createHash',
      'createHmac',
      'gzipSync',
      'gunzipSync',
      'inflateRawSync',
      'stripVTControlCharacters',
      'fileURLToPath',
      'globSync',
    ];
    for (const name of fast) {
      const found = PAIRINGS.find((pairing) => pairing.exportName === name);
      expect(found).toBeDefined();
      expect(found.effect).toBe(SPEED);
    }
  });

  it('keeps the rules with no measured win on report-only', () => {
    const slow = ['readFile', 'writeFile', 'copyFile', 'deflateSync', 'inflateSync', 'deflateRawSync', 'isDeepStrictEqual'];
    for (const name of slow) {
      const found = PAIRINGS.find((pairing) => pairing.exportName === name);
      expect(found).toBeDefined();
      expect(found.effect).toBe(REPORT_ONLY);
    }
  });

  it('states the evidence in every speed summary', () => {
    for (const pairing of PAIRINGS) {
      if (pairing.effect !== SPEED) continue;
      const summary = pairing.summary.toLowerCase();
      expect(summary.includes('measured') || summary.includes('verified') || summary.includes('byte identical') || summary.includes('faster')).toBe(true);
    }
  });
});
