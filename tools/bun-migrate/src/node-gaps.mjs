import { collectNodeBindings, collectRequireBindings, ts } from './ast.mjs';

/**
 * The other half of the migration: does Bun's node: layer have everything the
 * source already uses?
 *
 * Every rule in `pairings.mjs` asks "can this call move to a faster Bun API".
 * This module asks the opposite and more dangerous question: after the move to
 * Bun, does a `node:` import still resolve to something that exists? A missing
 * export does not fail at build time — it fails on the first call, in production.
 *
 * The list is not copied from a changelog. Each entry is a probe that runs at
 * migration time against the Bun doing the work, and a project is only warned
 * about what actually returns undefined.
 */

/**
 * Known gaps between Node's `node:` layer and Bun's.
 *
 * This list was produced by enumerating every export of 53 `node:` modules on
 * both runtimes and diffing the results (`enumerate-node.mjs` +
 * `compare-node-surface.mjs`), then keeping the public functions. Private
 * members, `prototype`, and the ZSTD_* constant block were excluded because
 * they are not call sites.
 *
 * `since` records the Bun version the probe was written against; the probe still
 * runs live, so a later Bun that closes a gap stops warning without a code
 * change. `workaround` is what a caller can do instead, because "missing" alone
 * is not actionable.
 */
export const KNOWN_NODE_GAPS = [
  {
    module: 'node:http2',
    member: 'constants.NGHTTP2_HCAT_REQUEST',
    since: '1.4.4',
    workaround:
      'these 13 http2 constants are non-enumerable in Node, so a key listing hides them; Bun does not define them at all. Use the numeric literal from the nghttp2 header if you need it',
  },
  {
    module: 'node:http2',
    member: 'constants.STREAM_OPTION_EMPTY_PAYLOAD',
    since: '1.4.4',
    workaround:
      'Bun omits the STREAM_OPTION_* constants entirely; branch on the flag you set yourself instead of reading the constant',
  },
  {
    module: 'node:module',
    member: 'registerHooks',
    since: '1.4.4',
    workaround: 'use module.register(), which Bun implements, or a loader on the Bun.plugin side',
  },
  {
    module: 'node:inspector',
    member: 'Network',
    since: '1.4.4',
    workaround: 'Bun implements the Profiler, Runtime and Debugger domains; the Network domain for request inspection has no counterpart',
  },
  {
    module: 'node:inspector',
    member: 'NetworkResources',
    since: '1.4.4',
    workaround: 'no Bun counterpart; capture request data at the fetch or server layer instead',
  },
  {
    module: 'node:module',
    member: 'stripTypeScriptTypes',
    since: '1.4.4',
    workaround: 'use Bun.Transpiler to strip types; it is the native path',
  },
  {
    module: 'node:module',
    member: 'findPackageJSON',
    since: '1.4.4',
    workaround: 'resolve the manifest with Bun.resolveSync and read it with Bun.file',
  },
  {
    module: 'node:module',
    member: 'getSourceMapsSupport',
    since: '1.4.4',
    workaround: 'Bun always applies source maps when it compiles; there is no switch to read',
  },
  {
    module: 'node:module',
    member: 'setSourceMapsSupport',
    since: '1.4.4',
    workaround: 'Bun always applies source maps when it compiles; there is no switch to set',
  },
  {
    module: 'node:util',
    member: 'transferableAbortController',
    since: '1.4.4',
    workaround: 'pass an AbortSignal across threads with postMessage; Bun does not mark controllers transferable',
  },
  {
    module: 'node:util',
    member: 'transferableAbortSignal',
    since: '1.4.4',
    workaround: 'an AbortSignal crosses a worker boundary through postMessage without this helper',
  },
  {
    module: 'node:util',
    member: 'diff',
    since: '1.4.4',
    workaround: 'no Bun equivalent; use a diff library or inspect both values',
  },
  {
    module: 'node:util',
    member: 'getCallSite',
    since: '1.4.4',
    workaround: 'read Error().stack, which Bun populates',
  },
  {
    module: 'node:console',
    member: 'context',
    since: '1.4.4',
    workaround: 'Bun has no console context; prefix your own output',
  },
  {
    module: 'node:console',
    member: 'createTask',
    since: '1.4.4',
    workaround: 'Bun has no console task API; log start and end yourself',
  },
  {
    module: 'node:crypto',
    member: 'encapsulate',
    since: '1.4.4',
    workaround: 'use crypto.subtle.encapsulate, which Bun implements for ML-KEM',
  },
  {
    module: 'node:crypto',
    member: 'decapsulate',
    since: '1.4.4',
    workaround: 'use crypto.subtle.decapsulate, which Bun implements for ML-KEM',
  },
  {
    module: 'node:dns',
    member: 'resolveTlsa',
    since: '1.4.4',
    workaround: 'resolve the TLSA record through a DNS library; Bun has no TLSA helper',
  },
  {
    module: 'node:dns/promises',
    member: 'resolveTlsa',
    since: '1.4.4',
    workaround: 'resolve the TLSA record through a DNS library; Bun has no TLSA helper',
  },
  {
    module: 'node:domain',
    member: 'Domain',
    since: '1.4.4',
    workaround: 'domains are deprecated in Node; use a try/catch around the async boundary',
  },
  {
    module: 'node:v8',
    member: 'queryObjects',
    since: '1.4.4',
    workaround: 'Bun.heapStats and the inspector protocol; there is no queryObjects',
  },
  {
    module: 'node:diagnostics_channel',
    member: 'boundedChannel',
    since: '1.4.4',
    workaround: 'use channel() and bound the queue yourself',
  },
];

/**
 * Bun-only APIs that do not exist in Node.
 *
 * These are the inverse hazard: code written here and copied back to Node, or a
 * dependency that runs both places, breaks the other way. Recorded so a shared
 * package knows what it cannot use.
 */
export const BUN_ONLY_APIS = [
  'Bun.file',
  'Bun.write',
  'Bun.spawn',
  'Bun.spawnSync',
  'Bun.SQL',
  'Bun.sql',
  'Bun.redis',
  'Bun.S3Client',
  'Bun.serve',
  'Bun.listen',
  'Bun.connect',
  'Bun.build',
  'Bun.Transpiler',
  'Bun.password',
  'Bun.hash',
  'Bun.YAML',
  'Bun.TOML',
  'Bun.JSON5',
  'Bun.JSONC',
  'Bun.JSONL',
  'Bun.markdown',
  'Bun.semver',
  'Bun.zstdCompressSync',
  'Bun.deepEquals',
  'Bun.deepMatch',
  'Bun.escapeHTML',
  'Bun.stripANSI',
  'Bun.stringWidth',
  'Bun.Glob',
  'Bun.Image',
  'Bun.Archive',
  'Bun.FFI',
  'Bun.Terminal',
  'Bun.WebView',
  'Bun.which',
  'Bun.cron',
  'Bun.secrets',
  'Bun.peek',
  'Bun.sleep',
  'Bun.nanoseconds',
  'Bun.openInEditor',
];

const cache = new Map();

/**
 * Does the running Bun actually expose this member?
 *
 * `member` may be a dotted path (`constants.NGHTTP2_HCAT_REQUEST`), because a
 * nested constant is a real call site and a flat lookup would silently miss it.
 * Importing the module can throw on its own, so the module load is guarded
 * separately from the member read.
 */
export function memberExists(moduleName, memberName) {
  const key = `${moduleName}#${memberName}`;
  if (cache.has(key)) return cache.get(key);
  let exists = false;
  try {
    const loaded = require(moduleName);
    let value = loaded;
    for (const part of memberName.split('.')) {
      if (value === undefined || value === null) {
        value = undefined;
        break;
      }
      value = value[part];
    }
    exists = value !== undefined;
  } catch {
    exists = false;
  }
  cache.set(key, exists);
  return exists;
}

/** Every recorded gap that this Bun still has, with the reason attached. */
export function activeGaps() {
  return KNOWN_NODE_GAPS.filter((gap) => !memberExists(gap.module, gap.member));
}

/** Gaps this Bun has closed, printed so a stale entry can be retired. */
export function closedGaps() {
  return KNOWN_NODE_GAPS.filter((gap) => memberExists(gap.module, gap.member));
}

function escapeRegExp(text) {
  return text.replaceAll(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Scan a parsed file for a call to a member the current Bun does not provide.
 *
 * The unit of evidence is a resolved binding, not a text match. Measured against
 * the old text rule (`\bname\s*\(`), five of seven inputs were wrong: a mention in
 * a comment matched, a string literal matched, a local function of the same name
 * matched, and a call on a different package's export matched. A warning that
 * fires on documentation is a warning people learn to ignore, which is what the
 * comment above this function always claimed and the code never did.
 *
 * `bindings` comes from `collectNodeBindings`, so the call is only counted when it
 * reaches the builtin through an import of that exact module.
 */
export function findMissingUsages(text, gaps, sourceFile) {
  const hits = [];
  const relevant = new Map();
  for (const gap of gaps) {
    if (!relevant.has(gap.module)) relevant.set(gap.module, []);
    relevant.get(gap.module).push(gap);
  }

  if (!sourceFile) {
    return legacyTextScan(text, relevant);
  }

  const bindings = collectNodeBindings(sourceFile);
  const required = collectRequireBindings(sourceFile);

  /**
   * Resolve an identifier or property chain to `{ module, path }`.
   *
   * `import { constants } from 'node:http2'` gives `constants.NGHTTP2_HCAT_REQUEST`
   * the path `constants.NGHTTP2_HCAT_REQUEST`, and a namespace import gives the
   * same path from `http2.constants.NGHTTP2_HCAT_REQUEST`. The nested http2 gaps
   * are constants, not calls, so resolving only call expressions missed them
   * entirely.
   */
  const resolvePath = (node) => {
    if (ts.isIdentifier(node)) {
      const binding = bindings.named.get(node.text);
      if (binding) return { module: binding.module, path: binding.imported };
      const namespace = bindings.namespaces.get(node.text);
      if (namespace) return { module: namespace, path: '' };
      const pulled = required.destructured.get(node.text);
      if (pulled) return { module: pulled.module, path: pulled.imported };
      const requiredNamespace = required.namespaceByLocal.get(node.text);
      if (requiredNamespace) return { module: requiredNamespace, path: '' };
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const inner = resolvePath(node.expression);
      if (!inner) return;
      return {
        module: inner.module,
        path: inner.path === '' ? node.name.text : `${inner.path}.${node.name.text}`,
      };
    }
    return;
  };

  /**
   * A name in a property or declaration position is not a reference to the
   * binding. Without this, `import { diff } from 'node:util'; const o = { diff: 1 }`
   * counted the object key as a use of the import.
   */
  const isNamePosition = (node) => {
    const parent = node.parent;
    if (!parent) return false;
    if (
      (ts.isPropertyAccessExpression(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isPropertyDeclaration(parent)) &&
      parent.name === node
    ) {
      return true;
    }
    if (
      (ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isBindingElement(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isClassExpression(parent)) &&
      parent.name === node
    ) {
      return true;
    }
    return false;
  };

  const visitReferences = (node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isPropertyAccessExpression(node)) {
      const resolved = resolvePath(node);
      if (resolved) {
        const candidates = relevant.get(resolved.module);
        if (candidates) {
          for (const gap of candidates) {
            if (gap.member === resolved.path) hits.push(gap);
          }
        }
      }
    } else if (ts.isIdentifier(node) && !isNamePosition(node)) {
      const resolved = resolvePath(node);
      if (resolved) {
        const candidates = relevant.get(resolved.module);
        if (candidates) {
          for (const gap of candidates) {
            if (gap.member === resolved.path) hits.push(gap);
          }
        }
      }
    }
    ts.forEachChild(node, visitReferences);
  };
  visitReferences(sourceFile);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    const candidates = relevant.get(specifier.text);
    if (!candidates) continue;
    const clause = statement.importClause;
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
    for (const element of clause.namedBindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      for (const gap of candidates) {
        if (gap.member === imported) hits.push(gap);
      }
    }
  }

  const unique = new Map();
  for (const hit of hits) unique.set(`${hit.module}#${hit.member}`, hit);
  return [...unique.values()];
}

/**
 * Fallback for callers that only have text.
 *
 * Kept for the suites that feed raw strings, and documented as the weaker path so
 * nobody mistakes it for the real one: it cannot tell a comment from a call.
 */
function legacyTextScan(text, relevant) {
  const hits = [];
  for (const [module, candidates] of relevant) {
    const modulePattern = escapeRegExp(module);
    for (const gap of candidates) {
      if (gap.member.includes('.')) {
        const leaf = escapeRegExp(gap.member.split('.').at(-1));
        const viaConstants = new RegExp(`\\bconstants\\s*\\.\\s*${leaf}\\b`).test(text);
        const viaImport =
          new RegExp(`\\b${leaf}\\b\\s*[,}]`).test(text) && text.includes(module);
        if (viaConstants || (viaImport && /constants/.test(text))) hits.push(gap);
        continue;
      }
      const memberPattern = escapeRegExp(gap.member);
      if (
        new RegExp(`\\b${memberPattern}\\s*\\(`).test(text) ||
        new RegExp(`\\{[^}]*\\b${memberPattern}\\b[^}]*\\}\\s*=\\s*require\\(['"]${modulePattern}['"]\\)`).test(text) ||
        new RegExp(`import\\s*\\{[^}]*\\b${memberPattern}\\b[^}]*\\}\\s*from\\s*['"]${modulePattern}['"]`).test(text)
      ) {
        hits.push(gap);
      }
    }
  }
  return hits;
}
