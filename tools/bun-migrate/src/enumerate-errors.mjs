/**
 * Enumerate error shapes on both runtimes.
 *
 * Every `try/catch` in a Node project branches on one of three things: the error
 * class, the `.code` string, or the `.message` text. A migration that changes any
 * of them makes the catch block take a different path, and none of it shows up in
 * an API-surface comparison.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Synchronous probes. Each one must throw without a `try` of its own, because the
 * runner below is the only catch and it needs the original error.
 */
const PROBES = [
  ['fs', 'read a missing file', () => require('node:fs').readFileSync('/definitely/not/here.txt', 'utf8')],
  ['fs', 'stat a missing file', () => require('node:fs').statSync('/definitely/not/here.txt')],
  ['fs', 'readdir a missing dir', () => require('node:fs').readdirSync('/definitely/not/here')],
  ['fs', 'unlink a missing file', () => require('node:fs').unlinkSync('/definitely/not/here.txt')],
  ['fs', 'write into a missing dir', () => require('node:fs').writeFileSync('/definitely/not/here/x.txt', 'a')],
  ['fs', 'read a directory as a file', () => require('node:fs').readFileSync(process.cwd(), 'utf8')],
  ['fs', 'open with a bad flag', () => require('node:fs').openSync(process.execPath, 'not-a-flag')],
  ['fs', 'error.path for a relative path', () => require('node:fs').readFileSync('relative/definitely-not-here.txt', 'utf8')],
  ['crypto', 'createHash unknown algorithm', () => require('node:crypto').createHash('not-a-hash')],
  ['crypto', 'timingSafeEqual different lengths', () => require('node:crypto').timingSafeEqual(Buffer.from('a'), Buffer.from('bb'))],
  ['crypto', 'randomInt bad range', () => require('node:crypto').randomInt(10, 1)],
  ['json', 'parse invalid', () => JSON.parse('{not json')],
  ['sqlite', 'bad sql', () => { const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); try { db.exec('NOT SQL'); } finally { db.close(); } }],
  ['url', 'invalid url', () => new URL('not a url')],
  ['buffer', 'invalid encoding', () => Buffer.from('x').toString('not-an-encoding')],
  ['assert', 'failed assertion', () => require('node:assert').strictEqual(1, 2)],
  ['child_process', 'missing binary', () => {
    const result = require('node:child_process').spawnSync('definitely-not-a-real-binary-xyz');
    if (result.error) throw result.error;
    return result;
  }],
  ['child_process', 'spawnSync result keys', () =>
    Object.keys(require('node:child_process').spawnSync('definitely-not-a-real-binary-xyz')).join(',')],
];

/**
 * Asynchronous probes, each resolving to the rejection it produced. They resolve
 * rather than reject so this file can be `await`ed without leaving an unhandled
 * rejection behind: an unhandled rejection is a non-zero exit, which the runner
 * would misreport as a crashed child instead of an observed error.
 */
const ASYNC_PROBES = [
  ['promises', 'readFile a missing file', () => require('node:fs').promises.readFile('/definitely/not/here.txt', 'utf8')],
  ['promises', 'stat a missing file', () => require('node:fs').promises.stat('/definitely/not/here.txt')],
  ['promises', 'readdir a missing dir', () => require('node:fs').promises.readdir('/definitely/not/here')],
  ['promises', 'realpath a missing path', () => require('node:fs').promises.realpath('/definitely/not/here')],
  ['promises', 'mkdir an existing dir', () => require('node:fs').promises.mkdir(process.cwd())],
  ['promises', 'abort a read with an aborted signal', () =>
    require('node:fs').promises.readFile(process.execPath, { signal: AbortSignal.abort() })],
  ['dns', 'lookup an unresolvable host', () =>
    require('node:dns').promises.lookup('definitely-not-a-real-host-xyz.invalid')],
  ['zlib', 'gunzip a non-gzip buffer', () => require('node:zlib').gunzipSync(Buffer.from('not gzip'))],
  ['stream', 'emit error after end', () => new Promise((resolve, reject) => {
    const { Writable } = require('node:stream');
    const writable = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    writable.on('error', reject);
    writable.end();
    writable.write('x');
  })],
  ['net', 'listen on an occupied port', () => new Promise((resolve, reject) => {
    const net = require('node:net');
    const first = net.createServer();
    first.listen(0, '127.0.0.1', () => {
      const second = net.createServer();
      second.on('error', (error) => { first.close(); reject(error); });
      second.listen(first.address().port, '127.0.0.1');
    });
  })],
  ['child_process', 'exec a missing binary', () => new Promise((resolve, reject) => {
    require('node:child_process').exec('definitely-not-a-real-binary-xyz', (error) => {
      if (error) reject(error);
      else resolve();
    });
  })],
];

function errorName(error) {
  if (error === undefined || error === null) return { thrown: false };
  const proto = Object.getPrototypeOf(error);
  const constructorName = error.constructor?.name ?? 'unknown';
  const rawPath = error.path;
  return {
    thrown: true,
    constructor: constructorName,
    prototypeChain: (() => {
      const chain = [];
      let current = proto;
      while (current && current !== Object.prototype) {
        chain.push(current.constructor?.name ?? 'unknown');
        current = Object.getPrototypeOf(current);
      }
      return chain;
    })(),
    code: error.code,
    name: error.name,
    nameMatchesConstructor: constructorName === (error.name ?? 'unknown'),
    errno: error.errno,
    syscall: error.syscall,
    pathIsAbsolute:
      typeof rawPath === 'string'
        ? /^[A-Za-z]:[\\/]/.test(rawPath) || rawPath.startsWith('\\\\') || rawPath.startsWith('/')
        : null,
    isError: error instanceof Error,
    isTypeError: error instanceof TypeError,
    isRangeError: error instanceof RangeError,
    isAbortError: constructorName === 'AbortError',
    messagePrefix: String(error.message ?? '').slice(0, 60),
  };
}

const engine = process.argv[2];
const report = { engine, version: engine === 'bun' ? Bun.version : process.version, cases: {} };

for (const [group, label, fn] of PROBES) {
  if (typeof group !== 'string' || typeof label !== 'string') continue;
  const key = `${group}: ${label}`;
  try {
    const value = fn();
    report.cases[key] = { thrown: false, value: typeof value === 'string' ? value : null };
  } catch (error) {
    report.cases[key] = errorName(error);
  }
}

for (const [group, label, fn] of ASYNC_PROBES) {
  if (typeof group !== 'string' || typeof label !== 'string') continue;
  const key = `${group}: ${label}`;
  try {
    const value = await fn();
    report.cases[key] = { thrown: false, value: typeof value === 'string' ? value : null };
  } catch (error) {
    report.cases[key] = errorName(error);
  }
}

process.stdout.write(JSON.stringify(report));
