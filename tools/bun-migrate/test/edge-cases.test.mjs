import { describe, expect, it } from 'bun:test';
/**
 * Edge cases and failure paths.
 *
 * The other suites prove the happy path. This one attacks the places a text
 * rewrite breaks: shadowed names, re-exports, multiple imports of the same
 * symbol, re-assignment, and code that only looks like a builtin call.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectNodeBindings, parse, resolveBuiltinCall, ts, walkCalls } from '../src/ast.mjs';
import { createJournal } from '../src/journal.mjs';
import { applySourceLayer } from '../src/layers/source.mjs';
import { applyTestLayer } from '../src/layers/tests.mjs';
import { loadProject } from '../src/project.mjs';

function makeProject(files) {
  const root = mkdtempSync(join(tmpdir(), 'edge-'));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  writeFileSync(join(root, 'package.json'), '{"name":"edge","version":"1.0.0"}\n', 'utf8');
  return root;
}

function migrateSource(files) {
  const root = makeProject(files);
  try {
    const project = loadProject(root);
    const journal = createJournal(['source']);
    applySourceLayer(project, journal);
    const result = {};
    for (const change of journal.changes) result[change.file] = change.after;
    for (const skipped of journal.layers().flatMap((layer) => layer.skipped)) {
      result[`skip:${skipped.file}`] = skipped.reason;
    }
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function migrateTests(files) {
  const root = makeProject(files);
  try {
    const project = loadProject(root);
    const journal = createJournal(['tests']);
    applyTestLayer(project, journal);
    const result = {};
    for (const change of journal.changes) {
      result[change.file] = change.after;
      result[`detail:${change.file}`] = change.detail;
    }
    for (const skipped of journal.layers().flatMap((layer) => layer.skipped)) {
      result[`skip:${skipped.file}`] = skipped.reason;
    }
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('shadowing and name resolution', () => {
  it('leaves a locally defined function with a builtin name alone', () => {
    const output = migrateSource({
      'src/a.ts': [
        "import { createHash } from 'node:crypto';",
        'function readFile(p: string) { return p; }',
        "export const a = readFile('x');",
        "export const b = createHash('sha256').update('x').digest('hex');",
        '',
      ].join('\n'),
    });
    expect(output['src/a.ts']).toContain('readFile(');
    expect(output['src/a.ts']).toContain('Bun.CryptoHasher');
  });

  it('does not mistake a property access for the builtin', () => {
    const sourceFile = parse(
      'a.ts',
      "import { createHash } from 'node:crypto';\nconst obj = { createHash: (x: string) => x };\nobj.createHash('sha256');\n",
    );
    const bindings = collectNodeBindings(sourceFile);
    let resolved = 0;
    walkCalls(sourceFile, (call) => {
      if (resolveBuiltinCall(call, bindings)) resolved += 1;
    });
    expect(resolved).toBe(0);
  });

  it('does not resolve a call on a differently named object', () => {
    const sourceFile = parse(
      'a.ts',
      "import * as realFs from 'node:fs';\nconst fakeFs = { readFileSync: () => 1 };\nfakeFs.readFileSync('x');\n",
    );
    const bindings = collectNodeBindings(sourceFile);
    let resolved = 0;
    walkCalls(sourceFile, (call) => {
      if (resolveBuiltinCall(call, bindings)) resolved += 1;
    });
    expect(resolved).toBe(0);
  });

  it('resolves a namespace call through the real namespace only', () => {
    const sourceFile = parse('a.ts', "import * as fs from 'node:fs';\nfs.globSync('*.ts');\n");
    const bindings = collectNodeBindings(sourceFile);
    const found = [];
    walkCalls(sourceFile, (call) => {
      const resolved = resolveBuiltinCall(call, bindings);
      if (resolved) found.push(resolved.exportName);
    });
    expect(found).toEqual(['globSync']);
  });

  /**
   * A function-scoped `const` with an imported builtin's name hides the import
   * from every call the layer cannot prove is outside its scope. Measured before
   * this guard: the rewrite replaced the shadowed call, so `process(fn, buf)`
   * called `Bun.gzipSync` where the file called the parameter `fn` — a meaning
   * change a pure-rename diff hides. The conservative answer is to refuse every
   * call site of that name in the file and say why.
   */
  it('refuses a call site whose name a local const shadows', () => {
    const output = migrateSource({
      'src/a.ts': [
        "import { gzipSync } from 'node:zlib';",
        '',
        'export function process(fn: (b: Buffer) => Buffer, buf: Buffer): Buffer {',
        '  const gzipSync = fn;',
        '  return gzipSync(buf);',
        '}',
        '',
        'export function real(buf: Buffer): Buffer {',
        '  return gzipSync(buf);',
        '}',
        '',
      ].join('\n'),
    });
    // The file has no edit entry at all: every call site of the shadowed name
    // was refused, so the layer wrote nothing and only the skip speaks.
    expect(output['src/a.ts']).toBeUndefined();
    const reason = Object.entries(output).find(
      ([key, value]) => key.startsWith('skip:') && value.includes('shadow'),
    );
    expect(reason).toBeDefined();
    expect(reason[1]).toContain('gzipSync');
  });

  it('refuses a parameter that shadows an imported builtin', () => {
    const output = migrateSource({
      'src/a.ts': [
        "import { createHash } from 'node:crypto';",
        'export const wrap = (createHash: (alg: string) => { update: (v: string) => void }) => createHash("sha256");',
        '',
      ].join('\n'),
    });
    expect(output['src/a.ts']).toBeUndefined();
    const reason = Object.entries(output).find(
      ([key, value]) => key.startsWith('skip:') && value.includes('shadow'),
    );
    expect(reason).toBeDefined();
    expect(reason[1]).toContain('createHash');
  });

  it('still rewrites a sibling builtin that nothing shadows', () => {
    const output = migrateSource({
      'src/a.ts': [
        "import { gzipSync, gunzipSync } from 'node:zlib';",
        '',
        'export function process(fn: (b: Buffer) => Buffer, buf: Buffer): Buffer {',
        '  const gunzipSync = fn;',
        '  return gunzipSync(buf);',
        '}',
        '',
        'export function real(buf: Buffer): Buffer {',
        '  return gzipSync(buf);',
        '}',
        '',
      ].join('\n'),
    });
    expect(output['src/a.ts']).toContain('Bun.gzipSync(buf)');
    expect(output['src/a.ts']).toContain('return gunzipSync(buf);');
  });

  it('does not treat a node: require binding as a shadow of its own import', () => {
    const output = migrateSource({
      'src/a.ts': [
        "import { createHash } from 'node:crypto';",
        "import { gzipSync } from 'node:zlib';",
        '',
        'function inner() {',
        "  const { createHash: nodeHash } = require('node:crypto');",
        '  return nodeHash;',
        '}',
        '',
        "export const a = createHash('sha256').update('x').digest('hex');",
        'export const b = gzipSync(Buffer.alloc(4));',
        '',
      ].join('\n'),
    });
    expect(output['src/a.ts']).toContain('Bun.CryptoHasher');
    expect(output['src/a.ts']).toContain('Bun.gzipSync');
  });

  /**
   * `collectNodeBindings` lets a `require` binding overwrite an import of the
   * same name, so the rewrite would resolve the call through the require's
   * module — a different builtin than the import names. The shadow set is built
   * from the import statements themselves, so the conflict is caught and the
   * call site refused. `createHash` is the vehicle because a pairing exists for
   * it: the shadow check runs after the pairing lookup, so a shadowed call with
   * no pairing must not report anything at all.
   */
  it('refuses when a require of another module binds the same name as an import', () => {
    const output = migrateSource({
      'src/a.ts': [
        "import { createHash } from 'node:crypto';",
        '',
        'function inner() {',
        "  const { createHash } = require('my-crypto-shim');",
        '  return createHash;',
        '}',
        '',
        "export const a = createHash('sha256');",
        '',
      ].join('\n'),
    });
    expect(output['src/a.ts']).toBeUndefined();
    const reason = Object.entries(output).find(
      ([key, value]) => key.startsWith('skip:') && value.includes('shadow'),
    );
    expect(reason).toBeDefined();
  });

  it('stays silent about a shadowed name that has no pairing to rewrite', () => {
    const output = migrateSource({
      'src/a.ts': [
        "import { resolve } from 'node:path';",
        '',
        'function wait() {',
        '  return new Promise((resolve) => {',
        '    resolve(1);',
        '  });',
        '}',
        '',
        'export const p = () => wait();',
        '',
      ].join('\n'),
    });
    // node:path resolve has no pairing, so the shadow is ordinary code, not a
    // finding: the file is untouched and the skip list says nothing.
    expect(output['src/a.ts']).toBeUndefined();
    expect(
      Object.entries(output).find(
        ([key, value]) => key.startsWith('skip:') && value.includes('shadow'),
      ),
    ).toBeUndefined();
  });
});

describe('import shapes', () => {
  it('rewrites an aliased import while keeping the alias', () => {
    const output = migrateSource({
      'src/a.ts':
        "import { createHash as ch } from 'node:crypto';\nexport const a = ch('sha256').update('x').digest('hex');\n",
    });
    expect(output['src/a.ts']).toContain('Bun.CryptoHasher');
  });

  it('handles two builtins from one module', () => {
    const output = migrateSource({
      'src/a.ts': [
        "import { createHash, createHmac } from 'node:crypto';",
        "export const a = createHash('sha256').update('x').digest('hex');",
        "export const b = createHmac('sha256', 'k').update('x').digest('hex');",
        '',
      ].join('\n'),
    });
    expect(output['src/a.ts'].match(/Bun\.CryptoHasher/g)?.length).toBe(2);
  });

  it('skips a module imported with a bare specifier that is not node:', () => {
    const output = migrateSource({
      'src/a.ts': "import { createHash } from 'crypto';\nexport const a = createHash('sha256');\n",
    });
    expect(output['src/a.ts']).toBeUndefined();
  });
});

describe('argument shapes the rewrite must refuse', () => {
  it('refuses a computed algorithm', () => {
    const output = migrateSource({
      'src/a.ts':
        "import { createHash } from 'node:crypto';\nexport const a = (alg: string) => createHash(alg);\n",
    });
    expect(output['src/a.ts']).toBeUndefined();
    expect(output['skip:src/a.ts']).toContain('not a string literal');
  });

  it('refuses an algorithm this Bun does not implement', () => {
    const output = migrateSource({
      'src/a.ts':
        "import { createHash } from 'node:crypto';\nexport const a = createHash('not-a-real-hash');\n",
    });
    expect(output['src/a.ts']).toBeUndefined();
    expect(output['skip:src/a.ts']).toContain('no CryptoHasher support');
  });

  it('refuses a digest with a dynamic encoding', () => {
    const output = migrateSource({
      'src/a.ts': [
        "import { createHash } from 'node:crypto';",
        "export const a = (enc: string) => createHash('sha256').update('x').digest(enc as never);",
        '',
      ].join('\n'),
    });
    expect(output['src/a.ts']).toBeUndefined();
  });

  it('refuses gzip with an options argument', () => {
    const output = migrateSource({
      'src/a.ts':
        "import { gzipSync } from 'node:zlib';\nexport const a = gzipSync('x', { level: 9 });\n",
    });
    expect(output['src/a.ts']).toBeUndefined();
    expect(output['skip:src/a.ts']).toContain('options');
  });

  it('refuses glob with an option Bun.Glob cannot reproduce', () => {
    const output = migrateSource({
      'src/a.ts':
        "import { globSync } from 'node:fs';\nexport const a = globSync('*.ts', { cwd: '.', withFileTypes: true });\n",
    });
    expect(output['src/a.ts']).toBeUndefined();
    expect(output['skip:src/a.ts']).toContain('withFileTypes');
  });

  it('accepts glob with only cwd', () => {
    const output = migrateSource({
      'src/a.ts':
        "import { globSync } from 'node:fs';\nexport const a = globSync('*.ts', { cwd: '.' });\n",
    });
    expect(output['src/a.ts']).toContain('new Bun.Glob');
  });
});

describe('snapshots that mean something different under bun:test', () => {
  /**
   * These cases exist because the layer used to rewrite every file and leave the
   * snapshot assertion in place. Measured: a `describe`-scoped snapshot whose value
   * had been changed still passed after the rewrite, reporting `snapshots: +1 added`
   * because Bun keys the entry differently and therefore created rather than compared
   * it. Each case below pins one form that cannot be carried across.
   */
  const BLOCKED = [
    [
      'a describe-scoped toMatchSnapshot',
      [
        "import { describe, it, expect } from 'vitest';",
        "describe('outer', () => { it('works', () => { expect({ a: 1 }).toMatchSnapshot(); }); });",
        '',
      ].join('\n'),
      'describe',
    ],
    [
      'a hinted toMatchSnapshot',
      [
        "import { it, expect } from 'vitest';",
        "it('hinted', () => { expect(1).toMatchSnapshot('my hint'); });",
        '',
      ].join('\n'),
      'hint',
    ],
    [
      'toMatchFileSnapshot',
      [
        "import { it, expect } from 'vitest';",
        "it('file', async () => { await expect({ a: 1 }).toMatchFileSnapshot('./x.txt'); });",
        '',
      ].join('\n'),
      'toMatchFileSnapshot',
    ],
    [
      'expect.addSnapshotSerializer',
      [
        "import { expect } from 'vitest';",
        'expect.addSnapshotSerializer({ test: () => true, serialize: String });',
        '',
      ].join('\n'),
      'addSnapshotSerializer',
    ],
    [
      'toThrowErrorMatchingSnapshot',
      [
        "import { it, expect } from 'vitest';",
        "it('throws', () => { expect(() => { throw new Error('b'); }).toThrowErrorMatchingSnapshot(); });",
        '',
      ].join('\n'),
      'thrown snapshot',
    ],
  ];

  for (const [label, source, expectedReason] of BLOCKED) {
    it(`leaves a file with ${label} byte-identical and says why`, () => {
      const output = migrateTests({ 'src/a.test.ts': source });
      expect(output['src/a.test.ts']).toBeUndefined();
      expect(output['skip:src/a.test.ts']).toContain(expectedReason);
    });
  }

  it('still rewrites a file whose snapshots are compatible', () => {
    const output = migrateTests({
      'src/a.test.ts': [
        "import { it, expect } from 'vitest';",
        "it('plain', () => { expect({ a: 1 }).toMatchSnapshot(); });",
        '',
      ].join('\n'),
    });
    expect(output['src/a.test.ts']).toContain("from 'bun:test'");
  });

  it('still rewrites a file that only uses inline snapshots', () => {
    const output = migrateTests({
      'src/a.test.ts': [
        "import { it, expect } from 'vitest';",
        "it('inline', () => { expect({ a: 1 }).toMatchInlineSnapshot(`",
        '  {',
        '    "a": 1,',
        '  }',
        '`); });',
        '',
      ].join('\n'),
    });
    expect(output['src/a.test.ts']).toContain("from 'bun:test'");
  });

  it('rewrites an ordinary file that happens to mention describe', () => {
    const output = migrateTests({
      'src/a.test.ts': [
        "import { describe, it, expect } from 'vitest';",
        "describe('math', () => { it('adds', () => { expect(1 + 1).toBe(2); }); });",
        '',
      ].join('\n'),
    });
    expect(output['src/a.test.ts']).toContain("from 'bun:test'");
  });
});

describe('CommonJS require bindings', () => {
  /**
   * The layer used to skip these files outright: `collectNodeBindings` read only
   * import declarations, so a CommonJS project produced two empty maps and
   * `applySourceLayer` returned before looking at a single call. Nothing was
   * rewritten and nothing was reported, which is the failure mode a migration tool
   * must not have.
   */
  it('rewrites a call behind a destructured require', () => {
    const output = migrateSource({
      'src/a.cjs':
        "const { gzipSync } = require('node:zlib');\nmodule.exports = (b) => gzipSync(b);\n",
    });
    expect(output['src/a.cjs']).toContain('Bun.gzipSync');
  });

  it('rewrites a call behind a namespace require', () => {
    const output = migrateSource({
      'src/a.cjs':
        "const zlib = require('node:zlib');\nmodule.exports = (b) => zlib.gzipSync(b);\n",
    });
    expect(output['src/a.cjs']).toContain('Bun.gzipSync');
  });

  it('resolves an aliased destructured require', () => {
    const output = migrateSource({
      'src/a.cjs':
        "const { gzipSync: gz } = require('node:zlib');\nmodule.exports = (b) => gz(b);\n",
    });
    expect(output['src/a.cjs']).toContain('Bun.gzipSync');
  });

  it('rewrites crypto through require', () => {
    const output = migrateSource({
      'src/a.cjs':
        "const { createHash } = require('node:crypto');\nmodule.exports = (t) => createHash('sha256').update(t).digest('hex');\n",
    });
    expect(output['src/a.cjs']).toContain('Bun.CryptoHasher');
  });

  it('removes the require binding the rewrite made dead', () => {
    const output = migrateSource({
      'src/a.cjs':
        "const { gzipSync } = require('node:zlib');\nmodule.exports = (b) => gzipSync(b);\n",
    });
    expect(output['src/a.cjs'].includes('require(')).toBe(false);
  });

  it('keeps a sibling binding that no rule rewrites', () => {
    const output = migrateSource({
      'src/a.cjs': [
        "const { gzipSync, deflateSync } = require('node:zlib');",
        'module.exports = { a: (b) => gzipSync(b), b: (c) => deflateSync(c) };',
        '',
      ].join('\n'),
    });
    expect(output['src/a.cjs']).toContain('Bun.gzipSync');
    expect(output['src/a.cjs']).toContain("const { deflateSync } = require('node:zlib')");
    expect(output['src/a.cjs']).toContain('deflateSync(c)');
  });

  it('keeps a namespace require whose other member is still used', () => {
    const output = migrateSource({
      'src/a.cjs': [
        "const zlib = require('node:zlib');",
        'module.exports = { a: (b) => zlib.gzipSync(b), b: (c) => zlib.deflateSync(c) };',
        '',
      ].join('\n'),
    });
    expect(output['src/a.cjs']).toContain('Bun.gzipSync');
    expect(output['src/a.cjs']).toContain("const zlib = require('node:zlib')");
    expect(output['src/a.cjs']).toContain('zlib.deflateSync');
  });

  it('leaves a require behind a variable alone, because the module is not provable', () => {
    const output = migrateSource({
      'src/a.cjs':
        "const name = 'node:zlib';\nconst z = require(name);\nmodule.exports = (b) => z.gzipSync(b);\n",
    });
    expect(output['src/a.cjs']).toBeUndefined();
  });

  it('produces a file that still parses', () => {
    const output = migrateSource({
      'src/a.cjs': [
        "const { gzipSync, gunzipSync } = require('node:zlib');",
        "const { createHash } = require('node:crypto');",
        'module.exports = {',
        '  a: (b) => gzipSync(gunzipSync(b)),',
        "  h: (t) => createHash('sha256').update(t).digest('hex'),",
        '};',
        '',
      ].join('\n'),
    });
    const parsed = parse('src/a.cjs', output['src/a.cjs']);
    const diagnostics = parsed.parseDiagnostics ?? [];
    expect(diagnostics.map((d) => d.messageText).join(' | ')).toBe('');
  });
});

describe('test layer edge cases', () => {
  it('keeps expect when it was imported', () => {
    const output = migrateTests({
      'src/a.test.ts':
        "import { describe, it, expect } from 'vitest';\nit('x', () => { expect(1).toBe(1); });\n",
    });
    expect(output['src/a.test.ts']).toContain('expect');
    expect(output['src/a.test.ts']).toContain("from 'bun:test'");
  });

  it('keeps a renamed import intact', () => {
    const output = migrateTests({
      'src/a.test.ts':
        "import { it as test, expect as assert } from 'vitest';\ntest('x', () => { assert(1).toBe(1); });\n",
    });
    expect(output['src/a.test.ts']).toContain('it as test');
    expect(output['src/a.test.ts']).toContain('expect as assert');
  });

  it('leaves a file that already imports bun:test alone', () => {
    const output = migrateTests({
      'src/a.test.ts':
        "import { describe, it, expect } from 'bun:test';\nit('x', () => { expect(1).toBe(1); });\n",
    });
    expect(output['src/a.test.ts']).toBeUndefined();
  });

  it('reports test.each instead of rewriting it', () => {
    const output = migrateTests({
      'src/a.test.ts': [
        "import { it, expect } from 'vitest';",
        "it.each([[1]])('%s', (n) => { expect(n).toBe(1); });",
        '',
      ].join('\n'),
    });
    expect(output['detail:src/a.test.ts']).toContain('test.each');
  });

  it('reports vi.useFakeTimers instead of rewriting it', () => {
    const output = migrateTests({
      'src/a.test.ts': [
        "import { it, expect, vi } from 'vitest';",
        "it('x', () => { vi.useFakeTimers(); expect(1).toBe(1); });",
        '',
      ].join('\n'),
    });
    expect(output['skip:src/a.test.ts']).toContain('useFakeTimers');
  });
});

describe('journal integrity', () => {
  it('records before and after for every edit', () => {
    const root = makeProject({
      'src/a.ts':
        "import { createHash } from 'node:crypto';\nexport const a = createHash('sha256').update('x').digest('hex');\n",
    });
    try {
      const project = loadProject(root);
      const journal = createJournal(['source']);
      applySourceLayer(project, journal);
      for (const change of journal.changes) {
        expect(typeof change.before).toBe('string');
        expect(typeof change.after).toBe('string');
        expect(change.before).not.toBe(change.after);
        expect(change.layer).toBe('source');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a no-op when a layer is disabled', () => {
    const root = makeProject({
      'src/a.ts':
        "import { createHash } from 'node:crypto';\nexport const a = createHash('sha256');\n",
    });
    try {
      const project = loadProject(root);
      const journal = createJournal(['config']);
      applySourceLayer(project, journal);
      expect(journal.changes.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the file byte identical when nothing applies', () => {
    const original =
      "import { readFileSync } from 'node:fs';\nexport const a = () => readFileSync('x', 'utf8');\n";
    const root = makeProject({ 'src/a.ts': original });
    try {
      const project = loadProject(root);
      const journal = createJournal(['source']);
      applySourceLayer(project, journal);
      expect(journal.changes.length).toBe(0);
      expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('source parsing tolerates real-world syntax', () => {
  const CASES = [
    ['decorators', '@dec class A {}'],
    ['generics', 'function f<T extends object>(x: T): T { return x; }'],
    ['optional chaining', 'const a = b?.c?.();'],
    ['nullish', 'const a = b ?? c;'],
    ['satisfies', 'const a = { x: 1 } satisfies Record<string, number>;'],
    ['import attributes', "import data from './d.json' with { type: 'json' };"],
    ['top-level await', 'await Promise.resolve();'],
    ['jsx-free arrow generics', 'const f = <T,>(x: T) => x;'],
  ];

  for (const [label, snippet] of CASES) {
    it(`parses ${label}`, () => {
      const sourceFile = parse('probe.ts', `${snippet}\n`);
      expect(sourceFile.statements.length).toBeGreaterThan(0);
      expect(ts.isSourceFile(sourceFile)).toBe(true);
    });
  }
});

/**
 * The tests layer decides per import statement, and two shapes used to leave a
 * file that no longer runs: a namespace import was deleted while its references
 * stayed, and a file whose only import was `vi` lost the import that `mock`
 * needed. CommonJS require was skipped before it could even be reported.
 */
describe('tests layer import shapes', () => {
  const VITEST_FILE =
    "import { describe, it, expect } from 'vitest';\ndescribe('a', () => { it('b', () => expect(1).toBe(1)); });\n";

  it('leaves a namespace import alone instead of deleting it', () => {
    const output = migrateTests({
      'test/a.test.ts':
        "import * as vitest from 'vitest';\nvitest.describe('a', () => { vitest.it('b', () => {}); });\n",
    });
    expect(output['test/a.test.ts']).toBeUndefined();
    expect(output['skip:test/a.test.ts']).toContain('namespace import');
  });

  it('imports mock when the only vi import is removed', () => {
    const output = migrateTests({
      'test/a.test.ts': "import { vi } from 'vitest';\nexport const f = vi.fn();\n",
    });
    expect(output['test/a.test.ts']).toContain("import { mock } from 'bun:test';");
    expect(output['test/a.test.ts']).toContain('mock()');
  });

  it('reports a CommonJS require instead of skipping it silently', () => {
    const output = migrateTests({
      'test/a.test.js': "const { describe } = require('vitest');\ndescribe('a', () => {});\n",
    });
    expect(output['test/a.test.js']).toBeUndefined();
    expect(output['skip:test/a.test.js']).toContain('CommonJS');
  });

  it('leaves every test alone when portable = true', () => {
    const output = migrateTests({
      '.bun-migrate.toml': 'portable = true\n',
      'test/a.test.ts': VITEST_FILE,
    });
    expect(output['test/a.test.ts']).toBeUndefined();
    expect(output['skip:test/a.test.ts']).toContain('portable = true');
  });

  it('leaves a denied package test alone', () => {
    const output = migrateTests({
      '.bun-migrate.toml': 'deny = ["packages/browser"]\n',
      'packages/browser/test/a.test.ts': VITEST_FILE,
    });
    expect(output['packages/browser/test/a.test.ts']).toBeUndefined();
    expect(Object.keys(output).some((key) => key.startsWith('skip:'))).toBe(false);
  });

  it('rewrites an awaited resolves.not.toThrow assertion to await the promise', () => {
    const output = migrateTests({
      'test/a.test.ts': [
        "import { describe, expect, it } from 'vitest';",
        "import { readFile } from 'node:fs/promises';",
        "describe('a', () => {",
        "  it('reads', async () => {",
        "    await expect(readFile('x', 'utf8')).resolves.not.toThrow();",
        '  });',
        '});',
        '',
      ].join('\n'),
    });
    expect(output['test/a.test.ts']).toContain("await readFile('x', 'utf8');");
    expect(output['test/a.test.ts'].includes('.resolves')).toBe(false);
    expect(output['detail:test/a.test.ts']).toContain('resolves.not.toThrow');
  });

  it('leaves an un-awaited resolves.not.toThrow assertion for manual porting', () => {
    const output = migrateTests({
      'test/a.test.ts': [
        "import { expect, it } from 'vitest';",
        'it("a", () => {',
        '  const check = expect(Promise.resolve("x")).resolves.not.toThrow();',
        '});',
        '',
      ].join('\n'),
    });
    expect(output['test/a.test.ts']).toBeUndefined();
    expect(output['skip:test/a.test.ts']).toContain('by hand');
  });

  it('produces a test file Bun runs after the rewrite', () => {
    const root = makeProject({
      'test/a.test.ts': [
        "import { describe, expect, it } from 'vitest';",
        "describe('a', () => {",
        "  it('resolves', async () => {",
        "    await expect(Promise.resolve('x')).resolves.not.toThrow();",
        '  });',
        '});',
        '',
      ].join('\n'),
    });
    try {
      const project = loadProject(root);
      const journal = createJournal(['tests']);
      applyTestLayer(project, journal);
      journal.commit(root);
      const result = Bun.spawnSync(['bun', 'test', 'test/a.test.ts'], { cwd: root });
      expect(result.exitCode).toBe(0);
      expect(`${result.stdout.toString()}${result.stderr.toString()}`).toContain('1 pass');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
