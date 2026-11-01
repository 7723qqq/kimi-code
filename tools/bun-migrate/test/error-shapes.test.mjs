/**
 * Error shapes: what a catch block sees, across both runtimes.
 *
 * Every case runs the same operation on both runtimes in a separate process and
 * compares the observables a catch block can branch on: the constructor, `.name`,
 * `.code`, `.errno`, `.syscall`, and whether it threw at all. Message text is
 * recorded but not compared, because the wording differs without that being a
 * compatibility problem.
 *
 * The four recorded gaps are asserted in both directions: the table must describe
 * them, and a live run must still reproduce them. A gap that silently heals is
 * reported as such rather than left to rot in the table.
 */
import { describe, expect, it } from 'bun:test';

import {
  ERROR_CASES,
  ERROR_GAPS,
  ERROR_GAP_KEYS,
  describeShapeDifference,
  errorShape,
  gapFor,
  shapeDiffers,
} from '../src/error-shapes.mjs';

const nodeAvailable = (() => Bun.spawnSync(['node', '--version']).exitCode === 0)();

/**
 * Each case as a standalone script. Every script prints one JSON object holding
 * the shape it observed; nothing is left to reject, because an unhandled
 * rejection would turn into a non-zero exit and be reported as `child-failed`.
 */
const OPERATIONS = {
  'fs: read a missing file': `require('node:fs').readFileSync('/definitely/not/here.txt', 'utf8')`,
  'fs: stat a missing file': `require('node:fs').statSync('/definitely/not/here.txt')`,
  'fs: readdir a missing dir': `require('node:fs').readdirSync('/definitely/not/here')`,
  'fs: unlink a missing file': `require('node:fs').unlinkSync('/definitely/not/here.txt')`,
  'fs: write into a missing dir': `require('node:fs').writeFileSync('/definitely/not/here/x.txt', 'a')`,
  'fs: read a directory as a file': `require('node:fs').readFileSync(process.cwd(), 'utf8')`,
  'fs: open with a bad flag': `require('node:fs').openSync(process.execPath, 'not-a-flag')`,
  'fs: error.path for a relative path': `require('node:fs').readFileSync('relative/definitely-not-here.txt', 'utf8')`,
  'crypto: createHash unknown algorithm': `require('node:crypto').createHash('not-a-hash')`,
  'crypto: timingSafeEqual different lengths': `require('node:crypto').timingSafeEqual(Buffer.from('a'), Buffer.from('bb'))`,
  'crypto: randomInt bad range': `require('node:crypto').randomInt(10, 1)`,
  'json: parse invalid': `JSON.parse('{not json')`,
  'sqlite: bad sql': `(() => { const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); try { db.exec('NOT SQL'); } finally { db.close(); } })()`,
  'url: invalid url': `new URL('not a url')`,
  'buffer: invalid encoding': `Buffer.from('x').toString('not-an-encoding')`,
  'assert: failed assertion': `require('node:assert').strictEqual(1, 2)`,
  'child_process: missing binary': `(() => { const r = require('node:child_process').spawnSync('definitely-not-a-real-binary-xyz'); if (r.error) throw r.error; return 'spawned'; })()`,
  'child_process: spawnSync result keys': `(() => { const r = require('node:child_process').spawnSync('definitely-not-a-real-binary-xyz'); return Object.keys(r).join(','); })()`,
  'stream: write after end': `await new Promise((resolve, reject) => { const { Writable } = require('node:stream'); const w = new Writable({ write(_c, _e, cb) { cb(); } }); w.on('error', reject); w.end(); w.write('x'); })`,
  'promises: readFile a missing file': `await require('node:fs').promises.readFile('/definitely/not/here.txt', 'utf8')`,
  'promises: stat a missing file': `await require('node:fs').promises.stat('/definitely/not/here.txt')`,
  'promises: readdir a missing dir': `await require('node:fs').promises.readdir('/definitely/not/here')`,
  'promises: realpath a missing path': `await require('node:fs').promises.realpath('/definitely/not/here')`,
  'promises: mkdir an existing dir': `await require('node:fs').promises.mkdir(process.cwd())`,
  'promises: abort a read with an aborted signal': `await require('node:fs').promises.readFile(process.execPath, { signal: AbortSignal.abort() })`,
  // An invalid IP literal fails in getaddrinfo without a network round trip, so
  // this case is deterministic on any machine; a made-up DNS name waited for the
  // host resolver's timeout and measured the network, not the error shape.
  'dns: lookup an unresolvable host': `await require('node:dns').promises.lookup('999.999.999.999')`,
  'zlib: gunzip a non-gzip buffer': `require('node:zlib').gunzipSync(Buffer.from('not gzip'))`,
  'stream: emit error after end': `await new Promise((resolve, reject) => { const { Writable } = require('node:stream'); const w = new Writable({ write(_c, _e, cb) { cb(); } }); w.on('error', reject); w.end(); w.write('x'); })`,
  'net: listen on an occupied port': `await new Promise((resolve, reject) => { const net = require('node:net'); const first = net.createServer(); first.listen(0, '127.0.0.1', () => { const second = net.createServer(); second.on('error', (error) => { first.close(); reject(error); }); second.listen(first.address().port, '127.0.0.1'); }); })`,
  'child_process: exec a missing binary': `await new Promise((resolve, reject) => { require('node:child_process').exec('definitely-not-a-real-binary-xyz', (error) => (error ? reject(error) : resolve())); })`,
};

/**
 * The shape a case observes. Errors go through `errorShape`; the two non-error
 * cases (key order, and a bare value) return `{ thrown: false, value }`.
 */
const PRELUDE = `
const isAbsolutePath = (candidate) => /^[A-Za-z]:[\\\\/]/.test(candidate) || candidate.startsWith('\\\\\\\\') || candidate.startsWith('/');
const describeError = (error) => {
  const constructor = error.constructor?.name ?? 'unknown';
  const name = error.name ?? 'unknown';
  return {
    thrown: true,
    constructor,
    code: error.code ?? null,
    name,
    nameMatchesConstructor: constructor === name,
    errno: error.errno ?? null,
    syscall: error.syscall ?? null,
    pathIsAbsolute: typeof error.path === 'string' ? isAbsolutePath(error.path) : null,
    isAbortError: constructor === 'AbortError',
  };
};
`;

function scriptFor(body) {
  return `
${PRELUDE}
(async () => {
  try {
    const value = await (async () => { return ${body}; })();
    process.stdout.write(JSON.stringify({ thrown: false, value: typeof value === 'string' ? value : null }));
  } catch (error) {
    process.stdout.write(JSON.stringify(describeError(error)));
  }
})();
`;
}

function runCase(engine, key) {
  const result = Bun.spawnSync([engine, '-e', scriptFor(OPERATIONS[key])]);
  const stdout = result.stdout.toString().trim();
  if (result.exitCode !== 0 || stdout === '') {
    return { thrown: 'child-failed', detail: result.stderr.toString().slice(0, 200) };
  }
  const lastLine = stdout
    .split('\n')
    .toReversed()
    .find((line) => line.startsWith('{'));
  if (lastLine === undefined) {
    return { thrown: 'child-failed', detail: stdout.slice(0, 200) };
  }
  return JSON.parse(lastLine);
}

/** Compare two observed shapes on the fields a catch block can branch on. */
function assertAgrees(key, nodeShape, bunShape) {
  if (nodeShape.thrown === 'child-failed' || bunShape.thrown === 'child-failed') {
    expect(`node=${nodeShape.thrown} bun=${bunShape.thrown}`).toBe('node=thrown bun=thrown');
    return;
  }
  if (nodeShape.thrown !== bunShape.thrown) {
    expect(`threw node=${nodeShape.thrown} bun=${bunShape.thrown}`).toBe('threw equal');
    return;
  }
  expect(describeShapeDifference(nodeShape, bunShape)).toBe('');
}

describe('table invariants', () => {
  it('every non-null expectation names a recorded gap', () => {
    const bad = ERROR_CASES.filter(
      (entry) => entry.expect !== null && !ERROR_GAP_KEYS.includes(entry.expect),
    );
    expect(JSON.stringify(bad.map((entry) => `${entry.group}: ${entry.label}`))).toBe('[]');
  });

  it('every recorded gap is referenced by at least one case', () => {
    const referenced = new Set(ERROR_CASES.map((entry) => entry.expect).filter((key) => key !== null));
    const orphans = ERROR_GAP_KEYS.filter((key) => !referenced.has(key));
    expect(JSON.stringify(orphans)).toBe('[]');
  });

  it('every case in the table has a script to run', () => {
    for (const entry of ERROR_CASES) {
      const key = `${entry.group}: ${entry.label}`;
      expect(`${key} script=${typeof OPERATIONS[key]}`).toBe(`${key} script=string`);
    }
  });

  it('no script is left unlisted', () => {
    const listed = new Set(ERROR_CASES.map((entry) => `${entry.group}: ${entry.label}`));
    const unlisted = Object.keys(OPERATIONS).filter((key) => !listed.has(key));
    expect(JSON.stringify(unlisted)).toBe('[]');
  });

  it('every recorded gap states what breaks and what to do instead', () => {
    for (const gap of ERROR_GAPS) {
      expect(`${gap.key} breaks=${typeof gap.breaks}`).toBe(`${gap.key} breaks=string`);
      expect(`${gap.key} workaround=${typeof gap.workaround}`).toBe(`${gap.key} workaround=string`);
      expect(`${gap.key} node=${typeof gap.node}`).toBe(`${gap.key} node=string`);
      expect(`${gap.key} bun=${typeof gap.bun}`).toBe(`${gap.key} bun=string`);
    }
  });

  it('gapFor resolves a recorded key and rejects an unknown one', () => {
    expect(gapFor(ERROR_GAP_KEYS[0])?.key).toBe(ERROR_GAP_KEYS[0]);
    expect(gapFor('not-a-gap')).toBe(null);
  });
});

describe('error shapes agree across runtimes', () => {
  for (const entry of ERROR_CASES) {
    const key = `${entry.group}: ${entry.label}`;
    if (entry.expect === null) {
      it(key, () => {
        if (!nodeAvailable) throw new Error('node must be on PATH: every differential case compares two runtimes, so skipping it would report a pass that proves nothing');
        assertAgrees(key, runCase('node', key), runCase('bun', key));
      });
      continue;
    }
    it(`${key} still diverges as recorded`, () => {
      if (!nodeAvailable) throw new Error('node must be on PATH: every differential case compares two runtimes, so skipping it would report a pass that proves nothing');
      const nodeShape = runCase('node', key);
      const bunShape = runCase('bun', key);
      const difference = describeShapeDifference(nodeShape, bunShape);
      const gap = gapFor(entry.expect);
      expect(`${key} differs=${difference !== ''}`).toBe(`${key} differs=true`);
      expect(`${key} registered=${gap !== null}`).toBe(`${key} registered=true`);
      expect(`${key} explains=${typeof gap?.breaks}`).toBe(`${key} explains=string`);
    });
  }
});

describe('the comparison itself is trustworthy', () => {
  it('shapeDiffers sees a different constructor', () => {
    expect(
      shapeDiffers(
        { thrown: true, constructor: 'Error', code: 'X' },
        { thrown: true, constructor: 'TypeError', code: 'X' },
      ),
    ).toBe(true);
  });

  it('shapeDiffers sees a different code', () => {
    expect(
      shapeDiffers(
        { thrown: true, constructor: 'Error', code: 'ENOENT' },
        { thrown: true, constructor: 'Error', code: 'EACCES' },
      ),
    ).toBe(true);
  });

  it('shapeDiffers sees a different errno with the same code', () => {
    expect(
      shapeDiffers(
        { thrown: true, constructor: 'Error', code: 'ENOTFOUND', errno: -3008 },
        { thrown: true, constructor: 'Error', code: 'ENOTFOUND', errno: 4 },
      ),
    ).toBe(true);
  });

  it('shapeDiffers sees a different syscall with the same code', () => {
    expect(
      shapeDiffers(
        { thrown: true, constructor: 'Error', code: 'ENOENT', syscall: 'open' },
        { thrown: true, constructor: 'Error', code: 'ENOENT', syscall: 'stat' },
      ),
    ).toBe(true);
  });

  it('shapeDiffers sees the AbortError class identity move', () => {
    expect(
      shapeDiffers(
        { thrown: true, constructor: 'AbortError', code: 'ABORT_ERR', isAbortError: true },
        { thrown: true, constructor: 'Error', code: 'ABORT_ERR', isAbortError: false },
      ),
    ).toBe(true);
  });

  it('shapeDiffers sees a throw becoming a non-throw', () => {
    expect(shapeDiffers({ thrown: true, constructor: 'Error', code: 'X' }, { thrown: false })).toBe(
      true,
    );
  });

  it('shapeDiffers ignores message wording', () => {
    const left = errorShape(new Error('Cannot read file A'));
    const right = errorShape(new Error('Unable to read B'));
    expect(shapeDiffers(left, right)).toBe(false);
  });

  it('errorShape records the class a catch block would branch on', () => {
    const shape = errorShape(new TypeError('bad'));
    expect(shape.constructor).toBe('TypeError');
    expect(shape.isTypeError).toBe(true);
    expect(shape.isRangeError).toBe(false);
  });

  it('errorShape notices when name and constructor disagree', () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    const shape = errorShape(error);
    expect(shape.name).toBe('AbortError');
    expect(shape.constructor).toBe('Error');
    expect(shape.nameMatchesConstructor).toBe(false);
    expect(shape.isAbortError).toBe(false);
  });

  it('describeShapeDifference names the fields that moved', () => {
    const described = describeShapeDifference(
      { thrown: true, constructor: 'Error', code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo' },
      { thrown: true, constructor: 'Error', code: 'ENOTFOUND', errno: 4, syscall: 'getaddrinfo' },
    );
    expect(described.includes('errno')).toBe(true);
    expect(described.includes('syscall')).toBe(false);
  });

  it('comparedFields concept: a non-error value is compared on the value itself', () => {
    expect(shapeDiffers({ thrown: false, value: 'a,b,c' }, { thrown: false, value: 'a,b,c' })).toBe(false);
    expect(shapeDiffers({ thrown: false, value: 'a,b,c' }, { thrown: false, value: 'b,a,c' })).toBe(true);
  });

  it('shapeDiffers sees a relative path where the other side resolved it', () => {
    expect(
      shapeDiffers(
        { thrown: true, constructor: 'Error', code: 'ENOENT', pathIsAbsolute: true },
        { thrown: true, constructor: 'Error', code: 'ENOENT', pathIsAbsolute: false },
      ),
    ).toBe(true);
  });
});
