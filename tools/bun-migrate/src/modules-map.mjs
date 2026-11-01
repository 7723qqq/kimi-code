/**
 * Module-level replacements that need more than a call-signature swap.
 *
 * `node:sqlite` -> `bun:sqlite` looks like a rename at the top and is not one
 * below: the module specifier changes, the class name changes, `get()` returns
 * `undefined` on one side and `null` on the other, and large integers silently
 * lose precision unless a statement opts in. None of that is visible from the
 * method names, so it is recorded here as measured behaviour.
 */

export const MODULE_REPLACEMENTS = [
  {
    id: 'sqlite',
    from: 'node:sqlite',
    to: 'bun:sqlite',
    rename: [
      ['DatabaseSync', 'Database'],
      ['StatementSync', 'Statement'],
    ],
    effect: 'report-only',
    verified: [
      'exec',
      'prepare',
      'all',
      'get',
      'iterate',
      'run',
      'positional binding',
      'named binding',
      'transaction',
    ],
    divergences: [
      {
        behaviour: 'get() on an empty result',
        node: 'returns undefined',
        bun: 'returns null',
        impact: 'a caller checking `=== undefined` changes branch on the Bun side',
      },
      {
        behaviour: 'integers above Number.MAX_SAFE_INTEGER',
        node: 'throws ERR_OUT_OF_RANGE until setReadBigInts(true)',
        bun: 'returns a number and silently rounds it unless statement.safeIntegers(true)',
        impact: 'the Bun default produces wrong data instead of an error, which is worse than throwing',
      },
      {
        behaviour: 'error code shape',
        node: 'ERR_SQLITE_ERROR',
        bun: 'SQLITE_ERROR',
        impact: 'code that switches on the error code stops matching after the swap',
      },
      {
        behaviour: 'large-integer opt-in',
        node: 'statement.setReadBigInts(true)',
        bun: 'statement.safeIntegers(true)',
        impact: 'a direct port has to rename the call, not just the module',
      },
    ],
    missing: [
      'applyChangeset',
      'createSession',
      'createTagStore',
      'deserialize',
      'enableDefensive',
      'enableLoadExtension',
      'location',
      'open',
      'setAuthorizer',
    ],
    extra: [
      'transaction',
      'query',
      'run',
      'inTransaction',
      'columnNames',
      'declaredTypes',
      'safeIntegers',
      'clearQueryCache',
    ],
    summary:
      'bun:sqlite covers the everyday path but changes three observable behaviours and lacks nine node:sqlite methods',
    requiredPrologue: [
      'open the database with `new Database(path)` instead of `new DatabaseSync(path)`',
      'call `statement.safeIntegers(true)` before reading any INTEGER column that may exceed 2^53',
      'treat a `null` result from `get()` the same way the old code treated `undefined`',
    ],
  },
  {
    id: 'http-server',
    from: 'node:http',
    to: 'Bun.serve',
    rename: [['createServer', 'Bun.serve']],
    effect: 'report-only',
    verified: ['request/response round trip', 'status code', 'json body', 'url with query'],
    divergences: [
      {
        behaviour: 'handler shape',
        node: 'createServer((req, res) => ...) with writable res',
        bun: 'Bun.serve({ fetch(request) { return response } }) returning a Response',
        impact: 'the handler body is a rewrite, not a rename; there is no res.write',
      },
      {
        behaviour: 'request body',
        node: 'req is a Readable stream',
        bun: 'request is a Web Request with .json()/.text()/.formData()',
        impact: 'every body read changes shape',
      },
      {
        behaviour: 'lifecycle',
        node: 'server.listen(port, cb) then server.close()',
        bun: 'Bun.serve({ port }) returns immediately with .port; server.stop()',
        impact: 'the listen callback disappears and port selection moves to a return value',
      },
    ],
    missing: [
      'res.writeHead',
      'res.write',
      'res.setHeader',
      'req.pipe',
      'server.on(upgrade)',
    ],
    extra: ['WebSocket upgrade built in', 'automatic TLS', 'Bun.serve development mode'],
    summary: 'Bun.serve is a different programming model, not a faster node:http',
    requiredPrologue: [
      'rewrite the handler to take a Request and return a Response',
      'replace res.writeHead + res.end with a Response carrying status and headers',
      'read the port from the object Bun.serve returns instead of the listen callback',
    ],
  },
];

export function moduleReplacementFor(specifier) {
  return MODULE_REPLACEMENTS.find((entry) => entry.from === specifier);
}

/**
 * Capability-level replacements: a library whose surface only partly overlaps a
 * Bun API.
 *
 * These are the hardest to automate and the easiest to get wrong. `sharp` and
 * `Bun.Image` agree on encode, resize and rotate, and disagree on everything
 * else. A rewrite that maps only the shared half leaves the rest calling methods
 * that do not exist, so the split is recorded explicitly.
 */
export const CAPABILITY_REPLACEMENTS = [
  {
    id: 'sharp',
    from: 'sharp',
    to: 'Bun.Image',
    effect: 'report-only',
    verified: [
      'png',
      'jpeg',
      'webp',
      'avif',
      'resize',
      'rotate',
      'flip',
      'flop',
      'metadata',
      'toBuffer',
    ],
    bunMissing: ['grayscale', 'blur', 'sharpen', 'composite', 'tint', 'extend', 'stats', 'raw', 'toFile', 'clone'],
    shapeDifferences: [
      {
        behaviour: 'pipeline entry',
        sharp: 'const out = await sharp(buffer).resize(16, 8).png().toBuffer()',
        bun: 'const out = await new Bun.Image(buffer).resize(16, 8).png().bytes()',
        impact: 'a factory call becomes a constructor, and toBuffer becomes bytes',
      },
      {
        behaviour: 'file output',
        sharp: '.toFile(path) writes and returns metadata',
        bun: '.write(path) exists, but .toFile does not',
        impact: 'any toFile call site needs a rewrite, not a rename',
      },
    ],
    summary:
      'Bun.Image covers encode, resize and rotate; grayscale, blur, sharpen, composite and the raw pipeline have no counterpart',
    requiredPrologue: [
      'replace `sharp(buffer)` with `new Bun.Image(buffer)`',
      'replace `.toBuffer()` with `.bytes()`',
      'audit every pipeline for grayscale, blur, sharpen, composite, tint, extend, stats or raw before switching',
    ],
  },
];

export function capabilityReplacementFor(packageName) {
  return CAPABILITY_REPLACEMENTS.find((entry) => entry.from === packageName);
}
