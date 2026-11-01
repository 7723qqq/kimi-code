/**
 * Error shapes: the dimension every `try/catch` depends on.
 *
 * A migration breaks quietly when a catch block branches on something that moved:
 * the error class, the `.code` string, `.errno`, `.syscall`, or the message prefix.
 * This file records both the synchronous and the asynchronous branches, runs both
 * runtimes, and keeps the comparison as a standing check so a future Bun that
 * regresses one is caught here.
 *
 * Two things a catch block can observe that the API surface never shows:
 *
 * - `.constructor.name` and `.name` can disagree. `af.name === 'AbortError'` is
 *   true on both runtimes, but `err instanceof AbortError` and
 *   `err.constructor.name === 'AbortError'` are not. Code that keys off the class
 *   identity silently takes the other branch.
 *
 * - `error.path` is absolute on Node and verbatim-as-passed on Bun. A retry loop
 *   that re-reads `error.path` resolves a different file.
 */

/**
 * What each case is meant to prove, so a change in the result is readable.
 *
 * `null` means the two runtimes are expected to agree exactly. Any entry with a
 * non-null value describes a divergence that has been confirmed and explained; the
 * value is the key into `ERROR_GAPS`.
 */
export const ERROR_CASES = [
  { group: 'fs', label: 'read a missing file', expect: null },
  { group: 'fs', label: 'stat a missing file', expect: null },
  { group: 'fs', label: 'readdir a missing dir', expect: null },
  { group: 'fs', label: 'unlink a missing file', expect: null },
  { group: 'fs', label: 'write into a missing dir', expect: null },
  { group: 'fs', label: 'read a directory as a file', expect: null },
  { group: 'fs', label: 'open with a bad flag', expect: null },
  { group: 'fs', label: 'error.path for a relative path', expect: 'error-path-relative' },
  { group: 'crypto', label: 'createHash unknown algorithm', expect: null },
  { group: 'crypto', label: 'timingSafeEqual different lengths', expect: null },
  { group: 'crypto', label: 'randomInt bad range', expect: null },
  { group: 'json', label: 'parse invalid', expect: null },
  { group: 'sqlite', label: 'bad sql', expect: null },
  { group: 'url', label: 'invalid url', expect: null },
  { group: 'buffer', label: 'invalid encoding', expect: null },
  { group: 'assert', label: 'failed assertion', expect: null },
  { group: 'child_process', label: 'missing binary', expect: null },
  { group: 'child_process', label: 'spawnSync result keys', expect: 'spawn-result-key-order' },
  { group: 'stream', label: 'write after end', expect: null },
  { group: 'promises', label: 'readFile a missing file', expect: null },
  { group: 'promises', label: 'stat a missing file', expect: null },
  { group: 'promises', label: 'readdir a missing dir', expect: null },
  { group: 'promises', label: 'realpath a missing path', expect: null },
  { group: 'promises', label: 'mkdir an existing dir', expect: null },
  { group: 'promises', label: 'abort a read with an aborted signal', expect: 'abort-error-class-identity' },
  { group: 'dns', label: 'lookup an unresolvable host', expect: 'dns-error-name' },
  { group: 'zlib', label: 'gunzip a non-gzip buffer', expect: null },
  { group: 'stream', label: 'emit error after end', expect: null },
  { group: 'net', label: 'listen on an occupied port', expect: 'socket-errno-native' },
  { group: 'child_process', label: 'exec a missing binary', expect: null },
];

/**
 * Confirmed divergences. Each entry names the observable that moved, what a catch
 * block sees on the wrong side, and the portable way to write the check.
 *
 * `sides` describes the two runtimes; `workaround` is what a migration should
 * rewrite the catch block to, or what it should stop doing.
 */
export const ERROR_GAPS = [
  {
    key: 'error-path-relative',
    observable: 'error.path',
    node: 'resolved to an absolute path',
    bun: 'left exactly as the caller passed it',
    breaks: 'a retry that re-reads error.path re-resolves a different file under Bun',
    workaround: 'call path.resolve(err.path) before reusing it; never assume it is absolute',
    severity: 'medium',
  },
  {
    key: 'spawn-result-key-order',
    observable: 'Object.keys(spawnSync(...))',
    node: 'error, status, signal, output, pid, stdout, stderr',
    bun: 'signal, status, output, pid, error, stdout, stderr',
    breaks: 'only code that serialises or destructures by key order; both have the same key set',
    workaround: 'read the named fields, never the key order; JSON output is not byte-comparable',
    severity: 'low',
  },
  {
    key: 'abort-error-class-identity',
    observable: 'error.constructor.name for an aborted fs operation',
    node: 'AbortError (a subclass of Error)',
    bun: 'Error, with only .name set to "AbortError"',
    breaks: 'err instanceof AbortError and err.constructor.name === "AbortError" are both false on Bun',
    workaround: 'branch on err.name === "AbortError" || err.code === "ABORT_ERR", never on the class',
    severity: 'high',
  },
  {
    key: 'dns-error-name',
    observable: 'error.name and error.errno for a failed lookup',
    node: 'name "Error", errno -3008',
    bun: 'name "DNSException", errno 4',
    breaks: 'a catch that branches on err.name, and any code that maps errno to a symbol',
    workaround: 'branch on err.code === "ENOTFOUND"; treat name and errno as unstable',
    severity: 'medium',
  },
  {
    key: 'socket-errno-native',
    observable: 'error.errno for a failed listen (EADDRINUSE)',
    node: '-4091, a negative libuv-style number',
    bun: '10048, the raw Windows WSA error code',
    breaks: 'code that switches on errno, or logs it expecting one sign convention',
    workaround: 'branch on err.code === "EADDRINUSE"; never compare errno numerically',
    severity: 'medium',
  },
];

/** Every gap key, so the table check can reject a typo. */
export const ERROR_GAP_KEYS = ERROR_GAPS.map((gap) => gap.key);

const GAP_BY_KEY = new Map(ERROR_GAPS.map((gap) => [gap.key, gap]));

export function gapFor(key) {
  return GAP_BY_KEY.get(key) ?? null;
}

/**
 * The observable a catch block can branch on.
 *
 * `pathIsAbsolute` is recorded instead of `path` itself because the raw value
 * carries the working directory and is not comparable across runs; whether it was
 * resolved is what a caller observes.
 */
export function errorShape(error) {
  if (error === undefined || error === null) return { thrown: false };
  const constructorName = error.constructor?.name ?? 'unknown';
  const ownName = error.name ?? 'unknown';
  const rawPath = error.path;
  return {
    thrown: true,
    constructor: constructorName,
    code: error.code,
    name: ownName,
    nameMatchesConstructor: constructorName === ownName,
    errno: error.errno,
    syscall: error.syscall,
    pathIsAbsolute: typeof rawPath === 'string' ? isAbsolutePath(rawPath) : null,
    isTypeError: error instanceof TypeError,
    isRangeError: error instanceof RangeError,
    isAbortError: constructorName === 'AbortError',
    messagePrefix: String(error.message ?? '').slice(0, 60),
  };
}

/** Absolute-path test that does not assume the current platform is POSIX. */
function isAbsolutePath(candidate) {
  if (candidate.startsWith('/')) return true;
  return /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\');
}

/** The fields a catch block can branch on, in reporting order. */
export const SHAPE_FIELDS = [
  'constructor',
  'name',
  'code',
  'errno',
  'syscall',
  'pathIsAbsolute',
  'isAbortError',
];

/**
 * Compare two shapes the way a catch block would see them.
 *
 * `errno` and `syscall` are compared because a catch block can and does branch on
 * them; `messagePrefix` is not, because wording differs without being a
 * compatibility problem. A case that returns a plain value instead of throwing is
 * compared on that value.
 */
export function shapeDiffers(left, right) {
  if (left.thrown !== right.thrown) return true;
  if (!left.thrown) return (left.value ?? null) !== (right.value ?? null);
  return SHAPE_FIELDS.some((field) => left[field] !== right[field]);
}

/** A one-line description of how two shapes differ, for a failure message. */
export function describeShapeDifference(left, right) {
  if (left.thrown !== right.thrown) return `thrown ${left.thrown} vs ${right.thrown}`;
  if (!left.thrown) {
    if ((left.value ?? null) === (right.value ?? null)) return '';
    return `value ${String(left.value)} vs ${String(right.value)}`;
  }
  return SHAPE_FIELDS.filter((field) => left[field] !== right[field])
    .map((field) => `${field} ${String(left[field])} vs ${String(right[field])}`)
    .join(', ');
}
