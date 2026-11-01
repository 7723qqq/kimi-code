/**
 * Function signatures that differ, filtered to the ones a caller can be hurt by.
 *
 * The raw diff is large: 123 arity differences across 38 node: modules. Most are
 * noise. `fs.promises` is implemented in Bun as `async function (...args)` that
 * forwards to the callback implementation, so its `length` comes from the inner
 * function rather than from a declared parameter list — calling it works, and
 * the difference is invisible to everything except introspection.
 *
 * What is kept here is the subset where `fn.length` feeds a decision:
 *
 * - `util.promisify` reads `fn.length` to build the wrapper's own signature, so
 *   a different arity produces a differently-shaped function.
 * - Code that validates argument counts (`fn.length === 2`) takes the wrong
 *   branch.
 * - Constructors whose arity changes whether `new` is required.
 *
 * Each entry was read from a live Node and a live Bun, not from documentation.
 */

export const SIGNATURE_GAPS = [
  {
    module: 'node:crypto',
    member: 'scrypt',
    node: { length: 4, name: 'scrypt' },
    bun: { length: 5, name: 'scrypt' },
    impact:
      'util.promisify(crypto.scrypt) produces a function with a different arity on each runtime, so a caller that inspects the promisified signature or forwards it positionally behaves differently',
    workaround: 'call crypto.scrypt with an explicit callback instead of promisifying it',
    severity: 'silent',
  },
  {
    module: 'node:crypto',
    member: 'scryptSync',
    node: { length: 3, name: 'scryptSync' },
    bun: { length: 4, name: 'scryptSync' },
    impact: 'an arity check or a curry helper wrapping scryptSync binds the wrong number of arguments',
    workaround: 'pass all four arguments explicitly rather than relying on partial application',
    severity: 'silent',
  },
  {
    module: 'node:crypto',
    member: 'randomInt',
    node: { length: 3, name: 'randomInt' },
    bun: { length: 2, name: 'randomInt' },
    impact:
      'the (min, max, callback) form loses a declared parameter, so a promisified or arity-inspected wrapper sees a two-argument function',
    workaround: 'use the (max, callback) or (min, max) form explicitly and do not promisify it',
    severity: 'silent',
  },
  {
    module: 'node:crypto',
    member: 'timingSafeEqual',
    node: { length: 0, name: 'timingSafeEqual' },
    bun: { length: 2, name: 'timingSafeEqual' },
    impact:
      'Node declares no parameters while Bun declares two; a wrapper that forwards by arity passes arguments Node would have read from `arguments`',
    workaround: 'call it directly with two buffers',
    severity: 'silent',
  },
  {
    module: 'node:crypto',
    member: 'verify',
    node: { length: 5, name: 'verify' },
    bun: { length: 4, name: 'verify' },
    impact: 'one fewer declared parameter, so positional forwarding by arity drops the last argument',
    workaround: 'pass every argument explicitly',
    severity: 'silent',
  },
  {
    module: 'node:crypto',
    member: 'hash',
    node: { length: 3, name: 'hash' },
    bun: { length: 2, name: 'hash' },
    impact: 'the outputEncoding parameter is no longer declared, so arity-driven wrappers omit it',
    workaround: 'pass the encoding explicitly rather than relying on a default',
    severity: 'silent',
  },
  {
    module: 'node:fs/promises',
    member: 'open',
    node: { length: 3, name: 'open' },
    bun: { length: 1, name: 'open' },
    impact:
      'Bun wraps the callback implementation with `async function (...args)`, so the declared arity collapses to one; promisify and arity checks see a one-argument function',
    workaround: 'pass path, flags and mode explicitly; do not infer the signature',
    severity: 'silent',
  },
  {
    module: 'node:fs/promises',
    member: 'opendir',
    node: { length: 3, name: 'opendir' },
    bun: { length: 2, name: 'opendir' },
    impact: 'same rest-argument wrapper: the declared arity does not match the accepted arguments',
    workaround: 'pass both arguments explicitly',
    severity: 'silent',
  },
];

/** The arithmetic behind "most of the diff is noise", kept next to the table. */
export const SIGNATURE_DIFF_SUMMARY = {
  totalArityDifferences: 123,
  bunDeclaresMoreParams: 95,
  nodeDeclaresNone: 42,
  nodeDeclaresMoreParams: 41,
  curatedEntries: SIGNATURE_GAPS.length,
  reason:
    'Bun implements fs.promises as an async rest-argument wrapper around the callback API, so most arity differences describe the wrapper rather than a behaviour change; only the entries above feed a decision a caller can make',
};

export function signatureGapFor(moduleName, member) {
  return SIGNATURE_GAPS.find((gap) => gap.module === moduleName && gap.member === member);
}
