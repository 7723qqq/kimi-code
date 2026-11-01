import { ts } from './ast.mjs';
import {
  cryptoHasherHmacSupports,
  cryptoHasherSupports,
  digestEncodingSupported,
} from './capabilities.mjs';

/**
 * Node -> Bun replacement rules.
 *
 * Three things decide whether a rule exists:
 *
 * 1. `check` proves the rewrite is behaviour preserving at this call site. A
 *    rule whose condition cannot be proven is reported, never applied.
 * 2. `effect` records what the rewrite buys. Two values exist: `speed`, where
 *    Bun's native implementation is on a faster path, and `report-only`, where it
 *    is not offered at all. A third value, `consistency` ("same result, only the
 *    mixing stops"), was defined here and never used by a rule — the category was
 *    documented in the README and reachable from `rules-report`, but no rule ever
 *    carried it, so it has been removed rather than left as an aspiration the
 *    report groups by.
 * 3. `REPORT_ONLY` marks the rules that must never be applied, because the
 *    replacement would change control flow or the shape of the result.
 *
 * What `REPORT_ONLY` does not mean: it does not mean the call falls back to
 * Node. Every `node:` specifier resolves to Bun's own implementation, compiled
 * into the runtime — `node:fs` through `internal/fs/binding`, `node:path`
 * through `$cpp("Path.cpp")`, `node:zlib` through
 * `$bindgen("node_zlib_binding.bind.ts")`. Leaving a `node:` call untouched
 * still runs on Bun. `REPORT_ONLY` says the Bun-native API is not a drop-in for
 * that call site, which is a different statement.
 *
 * Capability questions (which hash algorithms exist, which encodings a digest
 * takes) are answered by probing the running Bun, not a version-pinned list.
 */

const SPEED = 'speed';
const REPORT_ONLY = 'report-only';

const DIGEST_ENCODINGS = new Set(['hex', 'base64', 'base64url', 'latin1']);

function staticString(node) {
  if (!node) return;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return;
}

function firstArg(call) {
  return call.arguments && call.arguments.length > 0 ? call.arguments[0] : undefined;
}

function secondArg(call) {
  return call.arguments && call.arguments.length > 1 ? call.arguments[1] : undefined;
}

function argCount(call) {
  return call.arguments ? call.arguments.length : 0;
}

function provableHmacKey(node) {
  if (!node) return false;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (ts.isParenthesizedExpression(node)) return provableHmacKey(node.expression);
  if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) {
      return new Set(['Buffer', 'Uint8Array', 'ArrayBuffer', 'DataView']).has(callee.text);
    }
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'Buffer'
    ) {
      return new Set(['from', 'alloc', 'allocUnsafe']).has(callee.name.text);
    }
  }
  return false;
}

function outermostCall(node) {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (!parent) return current;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      current = parent;
      continue;
    }
    if (ts.isCallExpression(parent) && parent.expression === current) {
      current = parent;
      continue;
    }
    return current;
  }
}

/**
 * The first `.digest(...)` call reached from a hasher call, even when the
 * digest's result is used further (`...digest('hex').length`).
 *
 * `outermostCall` walked past `digest()` into whatever consumed its result, so
 * a chained property read made this return undefined and the encoding check
 * below was skipped for that shape.
 */
function digestCall(call) {
  let current = call;
  for (;;) {
    const parent = current.parent;
    if (!parent) return;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      const callNode = parent.parent;
      if (
        parent.name.text === 'digest' &&
        callNode !== undefined &&
        ts.isCallExpression(callNode) &&
        callNode.expression === parent
      ) {
        return callNode;
      }
      current = parent;
      continue;
    }
    if (ts.isCallExpression(parent) && parent.expression === current) {
      current = parent;
      continue;
    }
    return;
  }
}

function digestTextEncoding(call) {
  const chained = digestCall(call);
  if (!chained) return;
  const encoding = staticString(firstArg(chained));
  if (encoding && DIGEST_ENCODINGS.has(encoding)) return encoding;
  return;
}

function chainText(site) {
  const end = outermostCall(site.call);
  return site.sourceFile.text.slice(site.call.getStart(), end.getEnd());
}

function chainDigestCount(site) {
  return (chainText(site).match(/\.digest\(/g) ?? []).length;
}

/**
 * Whether a hasher bound to a local variable is consumed exactly once.
 *
 * `const h = createHash(...); h.update(...); h.digest()` is equivalent and is
 * rewritten. `h.digest(); h.digest()` is not: Node throws after the first Hash
 * digest and Bun returns an empty digest; for an HMAC, Node returns an empty
 * digest and Bun throws. The same applies to `update()` after `digest()`. A
 * hasher that escapes to an untracked use is reported rather than guessed at.
 */
function variableLifecycleReason(site, kind) {
  const end = outermostCall(site.call);
  const parent = end.parent;
  if (
    parent === undefined ||
    !ts.isVariableDeclaration(parent) ||
    !ts.isIdentifier(parent.name) ||
    parent.initializer !== end
  ) {
    return 'the hasher is not bound to a simple local variable and is not digested in the same expression; reuse cannot be ruled out';
  }
  const name = parent.name.text;
  const digestPositions = [];
  const updatePositions = [];
  const copyPositions = [];
  let untracked = false;
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === name) {
      const owner = node.parent;
      if (owner && ts.isVariableDeclaration(owner) && owner.name === node) return;
      if (owner && ts.isPropertyAccessExpression(owner) && owner.expression === node) {
        const method = owner.name.text;
        if (method === 'digest') digestPositions.push(node.getStart());
        else if (method === 'update') updatePositions.push(node.getStart());
        else if (method === 'copy') copyPositions.push(node.getStart());
        else untracked = true;
        return;
      }
      untracked = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(site.sourceFile);
  if (untracked) {
    return 'the hasher variable is used in a way this tool cannot track; reuse cannot be ruled out';
  }
  if (kind === 'hmac' && copyPositions.length > 0) {
    return 'Node HMAC has no copy(); Bun.CryptoHasher does, so the rewrite would enable code Node throws on';
  }
  if (digestPositions.length === 0) {
    return 'the hasher is never digested in a trackable call; the rewrite cannot be proven safe';
  }
  if (digestPositions.length > 1) {
    return 'the hasher is digested more than once; Node and Bun disagree after the first digest';
  }
  if (updatePositions.some((position) => position > digestPositions[0])) {
    return 'the hasher is updated after digest(); Node and Bun disagree after a digest';
  }
  if (copyPositions.some((position) => position > digestPositions[0])) {
    return 'the hasher is copied after digest(); the copy semantics cannot be proven';
  }
  return;
}

export const PAIRINGS = [
  {
    id: 'crypto-createHash',
    from: 'node:crypto',
    exportName: 'createHash',
    bunExpression: 'Bun.CryptoHasher',
    effect: SPEED,
    summary:
      'createHash(alg) -> new Bun.CryptoHasher(alg), measured 1.2x-1.9x faster across 16 B to 1 MB and 4 algorithms; only rewritten when the same expression digests once',
    condition:
      'the algorithm is one this Bun implements, a text digest pins an encoding it supports, and the call is chained to a single digest()',
    check(site) {
      if (argCount(site.call) > 1) {
        return 'a second argument (options) is passed; Bun.CryptoHasher does not accept the node options shape, so outputLength and similar settings would be silently dropped';
      }
      const algorithm = staticString(firstArg(site.call));
      if (!algorithm) return 'algorithm is not a string literal, so support cannot be proven';
      if (!cryptoHasherSupports(algorithm)) {
        return `this Bun (${Bun.version}) has no CryptoHasher support for "${algorithm}"`;
      }
      const chained = digestCall(site.call);
      if (chained === undefined) {
        const lifecycle = variableLifecycleReason(site, 'hash');
        if (lifecycle) return lifecycle;
      } else {
        if (chainDigestCount(site) > 1) {
          return 'the chain calls digest() more than once; Node throws after the first Hash digest and Bun returns an empty digest';
        }
        const text = chainText(site);
        const digestIndex = text.indexOf('.digest(');
        if (digestIndex >= 0 && /\.update\(/.test(text.slice(digestIndex))) {
          return 'the chain updates the hasher after digest(); Node and Bun disagree after a digest';
        }
        if (digestIndex >= 0 && /\.copy\(/.test(text.slice(digestIndex))) {
          return 'the chain copies the hasher after digest(); the copy semantics cannot be proven';
        }
      }
      const encoding = digestTextEncoding(site.call);
      if (encoding && !digestEncodingSupported(encoding)) {
        return `this Bun cannot digest to "${encoding}"`;
      }
      if (!encoding && chained) {
        const explicit = firstArg(chained);
        if (explicit !== undefined && staticString(explicit) === undefined) {
          return 'digest() encoding is dynamic, so the result type cannot be proven';
        }
      }
      return;
    },
    build(site, helpers) {
      return `new Bun.CryptoHasher(${helpers.text(firstArg(site.call))})`;
    },
  },
  {
    id: 'crypto-createHmac',
    from: 'node:crypto',
    exportName: 'createHmac',
    bunExpression: 'Bun.CryptoHasher',
    effect: SPEED,
    summary:
      'createHmac(alg, key) -> new Bun.CryptoHasher(alg, key), measured on the same faster native hasher path as createHash; the key must be a string, ArrayBuffer or ArrayBufferView (Node also accepts KeyObject/CryptoKey)',
    condition:
      'this Bun supports HMAC for the algorithm, the key is provably a string/ArrayBuffer/ArrayBufferView, and the call is chained to a single digest()',
    check(site) {
      if (argCount(site.call) > 2) {
        return 'an options argument is passed; Bun.CryptoHasher does not accept the node options shape, so it would be silently dropped';
      }
      const algorithm = staticString(firstArg(site.call));
      const key = secondArg(site.call);
      if (!algorithm) return 'algorithm is not a string literal';
      if (!key) return 'createHmac is called without a key';
      if (!provableHmacKey(key)) {
        return 'key type cannot be proven: Bun.CryptoHasher accepts a string, ArrayBuffer or ArrayBufferView, while Node also accepts KeyObject and CryptoKey';
      }
      if (!cryptoHasherHmacSupports(algorithm)) {
        return `this Bun (${Bun.version}) has no HMAC CryptoHasher support for "${algorithm}"`;
      }
      const chained = digestCall(site.call);
      if (chained === undefined) {
        const lifecycle = variableLifecycleReason(site, 'hmac');
        if (lifecycle) return lifecycle;
      } else {
        if (chainDigestCount(site) > 1) {
          return 'this chain calls digest() more than once; an HMAC CryptoHasher cannot be reused after digest()';
        }
        const text = chainText(site);
        const digestIndex = text.indexOf('.digest(');
        if (digestIndex >= 0 && /\.update\(/.test(text.slice(digestIndex))) {
          return 'the chain updates the HMAC after digest(); Node and Bun disagree after a digest';
        }
        if (text.includes('.copy(')) {
          return 'Node HMAC has no copy(); Bun.CryptoHasher does, so the rewrite would enable code Node throws on';
        }
      }
      return;
    },
    build(site, helpers) {
      return `new Bun.CryptoHasher(${helpers.text(firstArg(site.call))}, ${helpers.text(secondArg(site.call))})`;
    },
  },
  {
    id: 'fs-readFile-promises',
    from: 'node:fs/promises',
    exportName: 'readFile',
    bunExpression: 'Bun.file',
    effect: REPORT_ONLY,
    summary: 'Bun.file().text() measured 0.57x-0.86x of readFile from 16 B to 2 MB, slower at every size',
    condition:
      'never applied by default: measured 0.57x-0.86x of readFile at 16 B, 1 KB, 100 KB and 2 MB, and 0.81x under 50 parallel reads',
    check() {
      return "Bun.file().text() measured slower than readFile at every size, so swapping within Bun would be a regression; node:fs is already Bun's own implementation";
    },
    build() {},
  },
  {
    id: 'fs-writeFile-promises',
    from: 'node:fs/promises',
    exportName: 'writeFile',
    bunExpression: 'Bun.write',
    effect: REPORT_ONLY,
    summary: 'Bun.write measured 0.34x-0.78x of writeFile, worsening with payload size',
    condition:
      'never applied by default: measured 0.34x of writeFile at 2 MB and 0.59x-0.78x below that, so the rewrite is a regression that grows with payload',
    check() {
      return 'measured slower or equal: node:fs/promises.writeFile already sits on the same thread pool, so rewriting adds diff without a speedup';
    },
    build() {},
  },
  {
    id: 'fs-copyFile-promises',
    from: 'node:fs/promises',
    exportName: 'copyFile',
    bunExpression: 'Bun.write',
    effect: REPORT_ONLY,
    summary: 'copyFile and Bun.write(Bun.file()) measured 0.88x-1.19x, no consistent win',
    condition:
      'never applied by default: measured 0.88x-1.19x across 16 B to 2 MB, which is noise at best, and copyFile rejects a mode flag Bun.write cannot express',
    check() {
      return 'no measured benefit, and a COPYFILE_EXCL call site would lose its flag';
    },
    build() {},
  },
  {
    id: 'zlib-zstdCompressSync',
    from: 'node:zlib',
    exportName: 'zstdCompressSync',
    bunExpression: 'Bun.zstdCompressSync',
    effect: SPEED,
    summary: 'zstdCompressSync(data) -> Bun.zstdCompressSync(data), measured 1.4x-8.3x faster from 100 KB down to 16 B, and the frames are byte-identical',
    condition:
      'no options argument. Verified across 25 payloads from 1 B to 32 MB (random, repetitive, text, JSON) that node and Bun emit the same frame bytes, and that each runtime decodes the other output',
    check(site) {
      if (argCount(site.call) !== 1) return 'zstd options are passed, and Bun.zstdCompressSync takes its own options shape';
      return;
    },
    build(site, helpers) {
      return `Bun.zstdCompressSync(${helpers.text(firstArg(site.call))})`;
    },
  },
  {
    id: 'zlib-zstdDecompressSync',
    from: 'node:zlib',
    exportName: 'zstdDecompressSync',
    bunExpression: 'Bun.zstdDecompressSync',
    effect: SPEED,
    summary: 'zstdDecompressSync(data) -> Bun.zstdDecompressSync(data), measured 1.6x-81x faster and it decodes node frames',
    condition:
      'no options argument. Verified: Bun decodes node output and node decodes Bun output, in both directions at every measured size',
    check(site) {
      if (argCount(site.call) !== 1) return 'zstd options are passed, and Bun.zstdDecompressSync takes its own options shape';
      return;
    },
    build(site, helpers) {
      return `Bun.zstdDecompressSync(${helpers.text(firstArg(site.call))})`;
    },
  },
  {
    id: 'zlib-gzipSync',
    from: 'node:zlib',
    exportName: 'gzipSync',
    bunExpression: 'Bun.gzipSync',
    effect: SPEED,
    summary:
      'gzipSync(data) -> Buffer.from(Bun.gzipSync(data)), 3x-40x faster from 1 MB down to 16 B; the wrapping keeps the Buffer return type Node has (Bun returns Uint8Array), and the stream decodes in either runtime but is not byte-identical to one Node produced',
    condition:
      'no options argument. Verified: both produce the same 1f8b-prefixed stream that the other runtime can gunzip; the result is wrapped in Buffer so .toString(encoding), .equals and other Buffer methods keep working',
    check(site) {
      if (argCount(site.call) !== 1) return 'gzip options are passed, and Bun.gzipSync takes its own options shape';
      return;
    },
    build(site, helpers) {
      return `Buffer.from(Bun.gzipSync(${helpers.text(firstArg(site.call))}))`;
    },
  },
  {
    id: 'zlib-gunzipSync',
    from: 'node:zlib',
    exportName: 'gunzipSync',
    bunExpression: 'Bun.gunzipSync',
    effect: SPEED,
    summary:
      'gunzipSync(data) -> Buffer.from(Bun.gunzipSync(data)), 2.3x-17x faster across sizes; the wrapping keeps the Buffer return type Node has (Bun returns Uint8Array)',
    condition:
      'no options argument. Verified: both decode the same gzip stream, in both directions; the result is wrapped in Buffer so Buffer methods keep working',
    check(site) {
      if (argCount(site.call) !== 1) return 'gunzip options are passed, which Bun.gunzipSync does not take';
      return;
    },
    build(site, helpers) {
      return `Buffer.from(Bun.gunzipSync(${helpers.text(firstArg(site.call))}))`;
    },
  },
  {
    id: 'zlib-deflateSync-zlib-wrapped',
    from: 'node:zlib',
    exportName: 'deflateSync',
    bunExpression: '(none for the zlib-wrapped form)',
    effect: REPORT_ONLY,
    summary: 'Bun.deflateSync is raw deflate, not the zlib-wrapped stream deflateSync produces',
    condition:
      'never applied: verified that Bun.deflateSync output equals node deflateRawSync exactly, so a Bun deflate stream is unreadable by any zlib-wrapped inflater',
    check() {
      return 'format mismatch: node deflateSync emits a 78 9c header and adler32 tail, Bun emits neither; only deflateRawSync maps to Bun.deflateSync';
    },
    build() {},
  },
  {
    id: 'zlib-inflateSync-zlib-wrapped',
    from: 'node:zlib',
    exportName: 'inflateSync',
    bunExpression: '(none for the zlib-wrapped form)',
    effect: REPORT_ONLY,
    summary: 'Bun.inflateSync reads raw deflate and rejects a zlib-wrapped stream',
    condition:
      'never applied: verified that Bun.inflateSync fails on node deflateSync output with "invalid stored block lengths"',
    check() {
      return 'format mismatch: Bun.inflateSync expects raw deflate, so it rejects every stream node:zlib.deflateSync produces';
    },
    build() {},
  },
  {
    id: 'zlib-deflateRawSync',
    from: 'node:zlib',
    exportName: 'deflateRawSync',
    bunExpression: 'Bun.deflateSync',
    effect: REPORT_ONLY,
    summary: 'Bun.deflateSync is raw deflate, but its bytes diverge from deflateRawSync above a few hundred bytes',
    condition:
      'never applied: format matches, output bytes do not. Verified identical at 13 bytes, different at 1800 and 10000 bytes because the two pick different block boundaries and match strategies',
    check() {
      return 'byte-level divergence on larger payloads: a caller that hashes, stores or compares the compressed output would see a different value, even though both streams inflate correctly';
    },
    build() {},
  },
  {
    id: 'zlib-inflateRawSync',
    from: 'node:zlib',
    exportName: 'inflateRawSync',
    bunExpression: 'Bun.inflateSync',
    effect: SPEED,
    summary:
      'inflateRawSync(data) -> Buffer.from(Bun.inflateSync(data)), verified on both runtimes output; the wrapping keeps the Buffer return type Node has (Bun returns Uint8Array)',
    condition:
      'no options argument. Verified: Bun.inflateSync decodes node deflateRawSync output and vice versa; the result is wrapped in Buffer so Buffer methods keep working',
    check(site) {
      if (argCount(site.call) !== 1) return 'inflateRaw options are passed, which Bun.inflateSync does not take';
      return;
    },
    build(site, helpers) {
      return `Buffer.from(Bun.inflateSync(${helpers.text(firstArg(site.call))}))`;
    },
  },
  {
    id: 'zlib-brotliCompressSync',
    from: 'node:zlib',
    exportName: 'brotliCompressSync',
    bunExpression: '(none)',
    effect: REPORT_ONLY,
    summary: 'brotli has no Bun-native equivalent',
    condition: 'never applied: Bun exposes no brotli compressing API',
    check() {
      return "Bun ships no brotli helper; node:zlib resolves to Bun native code, so leaving the call alone already runs on Bun";
    },
    build() {},
  },
  {
    id: 'fs-readFileSync',
    from: 'node:fs',
    exportName: 'readFileSync',
    bunExpression: 'Bun.file',
    effect: REPORT_ONLY,
    summary: 'readFileSync -> Bun.file() is lazy and would change timing',
    condition: 'never applied: Bun.file() is lazy, so a sync call site would change behaviour',
    check() {
      return 'synchronous reads are reported only; Bun.file() is lazy and the value is not read until awaited';
    },
    build() {},
  },
  {
    id: 'fs-writeFileSync',
    from: 'node:fs',
    exportName: 'writeFileSync',
    bunExpression: 'Bun.write',
    effect: REPORT_ONLY,
    summary: 'writeFileSync -> Bun.write is async',
    condition: 'never applied: Bun.write returns a promise',
    check() {
      return 'Bun.write is asynchronous, so replacing a sync call would change control flow';
    },
    build() {},
  },
  {
    id: 'fs-globSync',
    from: 'node:fs',
    exportName: 'globSync',
    bunExpression: 'Bun.Glob',
    effect: SPEED,
    summary: 'globSync(pattern, {cwd}) -> [...new Bun.Glob(pattern).scanSync({cwd})], 2.0x-5.3x faster, the gap widening with directory size',
    condition: 'the pattern is a string literal and options are omitted or limited to cwd',
    check(site) {
      const pattern = staticString(firstArg(site.call));
      if (!pattern) return 'pattern is not a string literal';
      const options = secondArg(site.call);
      if (options && ts.isObjectLiteralExpression(options)) {
        const allowed = new Set(['cwd']);
        const keys = options.properties
          .map((property) => property.name?.text)
          .filter(Boolean);
        const extra = keys.filter((key) => !allowed.has(key));
        if (extra.length > 0) {
          return `options ${extra.join(', ')} are not reproduced by Bun.Glob.scanSync`;
        }
      } else if (options !== undefined) {
        return 'options are not an object literal, so their keys cannot be checked';
      }
      return;
    },
    build(site, helpers) {
      const pattern = helpers.text(firstArg(site.call));
      const options = secondArg(site.call);
      if (!options) {
        return `[...new Bun.Glob(${pattern}).scanSync()]`;
      }
      return `[...new Bun.Glob(${pattern}).scanSync(${helpers.text(options)})]`;
    },
  },
  {
    id: 'child_process-spawnSync',
    from: 'node:child_process',
    exportName: 'spawnSync',
    bunExpression: 'Bun.spawnSync',
    effect: REPORT_ONLY,
    summary: 'spawnSync(cmd, args, opts) -> Bun.spawnSync(argv, opts), result fields are renamed',
    condition:
      'never applied: the node form takes (cmd, args, opts) and returns {status,stdout,stderr}, while Bun returns {exitCode,stdout,stderr}',
    check() {
      return 'the call shape and result fields both differ, so a textual rewrite would silently break callers';
    },
    build() {
      return;
    },
  },
  {
    id: 'url-fileURLToPath',
    from: 'node:url',
    exportName: 'fileURLToPath',
    bunExpression: 'Bun.fileURLToPath',
    effect: SPEED,
    summary: 'fileURLToPath(u) -> Bun.fileURLToPath(u), about 2.6x faster',
    condition: 'single argument; both reject a non-absolute file URL the same way',
    check(site) {
      if (argCount(site.call) !== 1) return 'fileURLToPath takes exactly one argument';
      return;
    },
    build(site, helpers) {
      return `Bun.fileURLToPath(${helpers.text(firstArg(site.call))})`;
    },
  },
  {
    id: 'url-pathToFileURL',
    from: 'node:url',
    exportName: 'pathToFileURL',
    bunExpression: 'Bun.pathToFileURL',
    effect: REPORT_ONLY,
    summary: 'pathToFileURL differs from Node on Windows drive-letter resolution',
    condition:
      'never applied: on Windows node resolves /tmp/x to file:///D:/tmp/x while Bun keeps file:///tmp/x',
    check() {
      return 'verified difference on Windows: Node adds the current drive, Bun does not, so the resulting URL differs';
    },
    build() {},
  },
  {
    id: 'util-stripVTControlCharacters',
    from: 'node:util',
    exportName: 'stripVTControlCharacters',
    bunExpression: 'Bun.stripANSI',
    effect: SPEED,
    summary: 'stripVTControlCharacters(a) -> Bun.stripANSI(a), 15x-16x faster and flat across 13 B to 26 KB',
    condition: 'single string argument; both strip the same escape sequences',
    check(site) {
      if (argCount(site.call) !== 1) return 'stripVTControlCharacters takes exactly one argument';
      return;
    },
    build(site, helpers) {
      return `Bun.stripANSI(${helpers.text(firstArg(site.call))})`;
    },
  },
  {
    id: 'util-isDeepStrictEqual',
    from: 'node:util',
    exportName: 'isDeepStrictEqual',
    bunExpression: 'Bun.deepEquals',
    effect: REPORT_ONLY,
    summary: 'Bun.deepEquals treats an undefined-valued key as absent; isDeepStrictEqual does not',
    condition:
      'never applied: verified that isDeepStrictEqual({a:undefined}, {}) is false while Bun.deepEquals returns true, so a caller guarding a missing key would change behaviour',
    check() {
      return 'ownership semantics differ: node compares own keys, Bun ignores a key whose value is undefined';
    },
    build() {},
  },
  {
    id: 'util-format',
    from: 'node:util',
    exportName: 'format',
    bunExpression: '(none)',
    effect: REPORT_ONLY,
    summary: 'util.format has no Bun-native equivalent',
    condition: 'never applied: Bun ships no printf-style formatter',
    check() {
      return "Bun has no equivalent for util.format; node:util resolves to Bun native code, so leaving the call alone already runs on Bun";
    },
    build() {},
  },
];

export function pairingFor(moduleName, exportName) {
  return PAIRINGS.find((pairing) => pairing.from === moduleName && pairing.exportName === exportName);
}

export { SPEED, REPORT_ONLY };
