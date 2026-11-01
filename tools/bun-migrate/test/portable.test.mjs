import { describe, expect, it } from 'bun:test';
/**
 * The end-to-end contract: a migrated project must still run.
 *
 * The other suites check that each layer produces the rewrite it claims. This one
 * checks the thing a user actually means by "one command": take a working Node
 * project, migrate it, run it, and see it pass. It exists because three defects
 * shipped past the per-layer tests — a stale `node:` import, a `vitest run` script
 * that was never rewritten, and a `Bun.*` rewrite that made the code Node-only.
 *
 * Every case builds a real project in a temporary directory and runs it in a real
 * subprocess. Nothing is asserted from a string comparison alone.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from '../src/ast.mjs';
import { keepsNodePortable, loadProjectOverrides } from '../src/capabilities.mjs';
import { createJournal } from '../src/journal.mjs';
import { applyConfigLayer, rewriteTestRunnerScript } from '../src/layers/config.mjs';
import { applySourceLayer, dropUnusedNodeImports } from '../src/layers/source.mjs';
import { applyTestLayer } from '../src/layers/tests.mjs';
import { PAIRINGS } from '../src/pairings.mjs';
import { loadProject } from '../src/project.mjs';

const NODE_AVAILABLE = Bun.spawnSync(['node', '--version']).exitCode === 0;

function makeProject(files) {
  const root = mkdtempSync(join(tmpdir(), 'port-'));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  return root;
}

function migrate(root, layers) {
  const project = loadProject(root);
  const journal = createJournal(layers);
  if (layers.includes('config')) applyConfigLayer(project, journal);
  if (layers.includes('tests')) applyTestLayer(project, journal);
  if (layers.includes('source')) applySourceLayer(project, journal);
  for (const change of journal.changes) {
    if (change.kind === 'remove' || change.kind === 'note') continue;
    const absolute = join(root, change.file);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, change.after, 'utf8');
  }
  return journal;
}

function run(command, cwd) {
  const result = Bun.spawnSync(command, { cwd });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe('rewriteTestRunnerScript', () => {
  it('rewrites a bare runner invocation', () => {
    expect(rewriteTestRunnerScript('vitest run').script).toBe('bun test');
  });

  it('rewrites the runner without losing its arguments', () => {
    expect(rewriteTestRunnerScript('vitest run --coverage').script).toBe('bun test --coverage');
  });

  it('rewrites a runner behind another command', () => {
    expect(rewriteTestRunnerScript('tsc --noEmit && vitest run').script).toBe(
      'tsc --noEmit && bun test',
    );
  });

  it('rewrites after a directory change', () => {
    expect(rewriteTestRunnerScript('cd packages/a && vitest run').script).toBe(
      'cd packages/a && bun test',
    );
  });

  it('rewrites after an inline environment assignment', () => {
    expect(rewriteTestRunnerScript('NODE_ENV=test vitest run').script).toBe(
      'NODE_ENV=test bun test',
    );
  });

  it('rewrites jest', () => {
    expect(rewriteTestRunnerScript('jest --watch').script).toBe('bun test --watch');
  });

  it('drops the explicit run subcommand instead of keeping it as an argument', () => {
    expect(rewriteTestRunnerScript('bunx vitest run').script).toBe('bun test');
    expect(rewriteTestRunnerScript('pnpm vitest run').script).toBe('bun test');
    expect(rewriteTestRunnerScript('npx vitest run').script).toBe('bun test');
  });

  it.each([
    ['./node_modules/.bin/vitest', 'a path to the binary is not a bare invocation'],
    ['vitest-when', 'a package whose name starts with the runner is not the runner'],
    ['test-jest', 'a package whose name ends with the runner is not the runner'],
    ['my-vitest-thing', 'a substring is not a word'],
    ['node vitest.js', 'a file argument is not an invocation'],
    ['echo vitest', 'an argument is not an invocation'],
    ['npm test -- vitest', '-- forwards to another script, so this script runs nothing itself'],
  ])('leaves %s alone (%s)', (script) => {
    expect(rewriteTestRunnerScript(script).script).toBe(script);
    expect(rewriteTestRunnerScript(script).applied).toEqual([]);
  });

  it('rewrites both occurrences in a chain', () => {
    expect(rewriteTestRunnerScript('vitest run && vitest run').script).toBe('bun test && bun test');
  });

  it('rewrites a runner after a pipe', () => {
    expect(rewriteTestRunnerScript('vitest run | tap-spec').script).toBe('bun test | tap-spec');
  });

  it('does not touch an unrelated script', () => {
    expect(rewriteTestRunnerScript('node build.js').script).toBe('node build.js');
  });

  it('reports what it changed so the journal can explain it', () => {
    expect(rewriteTestRunnerScript('vitest run').applied).toEqual(['test runner']);
    expect(rewriteTestRunnerScript('node build.js').applied).toEqual([]);
  });
});

describe('dropUnusedNodeImports', () => {
  it('drops a named import whose only call was rewritten', () => {
    const original =
      "import { createHash } from 'node:crypto';\nexport const a = new Bun.CryptoHasher('x');\n";
    const rewritten = dropUnusedNodeImports(original, original, ['createHash']);
    expect(rewritten).toBe("export const a = new Bun.CryptoHasher('x');\n");
  });

  it('keeps an import that is still referenced', () => {
    const original = "import { createHash, randomUUID } from 'node:crypto';\nrandomUUID();\n";
    const rewritten = dropUnusedNodeImports(original, original, ['createHash']);
    expect(rewritten).toBe("import { randomUUID } from 'node:crypto';\nrandomUUID();\n");
  });

  it('handles a multi-line import clause', () => {
    const original = [
      'import {',
      '  createHash,',
      '  randomUUID,',
      "} from 'node:crypto';",
      'randomUUID();',
      '',
    ].join('\n');
    const rewritten = dropUnusedNodeImports(original, original, ['createHash']);
    expect(rewritten.includes('randomUUID')).toBe(true);
    expect(rewritten.includes('createHash')).toBe(false);
    expect(rewritten.includes('node:crypto')).toBe(true);
  });

  it('drops the whole statement when it was the only binding, without leaving a blank line', () => {
    const original = "import {\n  createHash,\n} from 'node:crypto';\nconst a = 1;\n";
    const rewritten = dropUnusedNodeImports(original, original, ['createHash']);
    expect(rewritten).toBe('const a = 1;\n');
  });

  it('resolves an alias to its local name', () => {
    const original = "import { createHash as ch } from 'node:crypto';\nconst a = 1;\n";
    expect(dropUnusedNodeImports(original, original, ['ch'])).toBe('const a = 1;\n');
  });

  it('does not treat a comment mentioning the name as a reference', () => {
    const original =
      "import { createHash } from 'node:crypto';\n// createHash was replaced\nconst a = 1;\n";
    expect(dropUnusedNodeImports(original, original, ['createHash'])).toBe(
      '// createHash was replaced\nconst a = 1;\n',
    );
  });

  it('does not treat a string literal mentioning the name as a reference', () => {
    const original = "import { createHash } from 'node:crypto';\nconst s = 'createHash';\n";
    expect(dropUnusedNodeImports(original, original, ['createHash'])).toBe(
      "const s = 'createHash';\n",
    );
  });

  it('keeps the import when the name is shadowed by a live local use', () => {
    const original =
      "import { createHash } from 'node:crypto';\nfunction f(createHash) { return createHash; }\n";
    expect(dropUnusedNodeImports(original, original, ['createHash'])).toBe(original);
  });

  it('does not count an object property as a reference to the binding', () => {
    const original = "import { createHash } from 'node:crypto';\nconst o = { createHash: 1 };\n";
    expect(dropUnusedNodeImports(original, original, ['createHash'])).toBe(
      'const o = { createHash: 1 };\n',
    );
  });

  it('keeps the whole line when nothing in it was rewritten', () => {
    const original = "import { readFileSync } from 'node:fs';\nreadFileSync('x');\n";
    expect(dropUnusedNodeImports(original, original, [])).toBe(original);
  });

  it('never drops a default or namespace import', () => {
    const original = "import fs from 'node:fs';\nimport * as path from 'node:path';\n";
    expect(dropUnusedNodeImports(original, original, ['fs', 'path'])).toBe(original);
  });

  it('leaves a non-node import alone', () => {
    const original = "import { parse } from 'yaml';\n";
    expect(dropUnusedNodeImports(original, original, ['parse'])).toBe(original);
  });

  it('leaves a bun: import alone', () => {
    const original = "import { Database } from 'bun:sqlite';\nconst db = 1;\n";
    expect(dropUnusedNodeImports(original, original, ['Database'])).toBe(original);
  });

  it('keeps a default import when the named binding beside it is dropped', () => {
    const original = "import def, { createHash } from 'node:crypto';\nconst x = 1;\n";
    expect(dropUnusedNodeImports(original, original, ['createHash'])).toBe(
      "import def from 'node:crypto';\nconst x = 1;\n",
    );
  });

  it('handles a from clause that wraps to the next line', () => {
    const original = "import { createHash } from\n  'node:crypto';\nconst x = 1;\n";
    expect(dropUnusedNodeImports(original, original, ['createHash'])).toBe('const x = 1;\n');
  });

  it('does not touch a re-export', () => {
    const original = "export { createHash } from 'node:crypto';\nconst x = 1;\n";
    expect(dropUnusedNodeImports(original, original, ['createHash'])).toBe(original);
  });

  it('does not touch a dynamic import', () => {
    const original = "const m = await import('node:crypto');\n";
    expect(dropUnusedNodeImports(original, original, ['createHash'])).toBe(original);
  });

  it('does not touch a type-only import', () => {
    const original = "import type { Hash } from 'node:crypto';\nconst x = 1;\n";
    expect(dropUnusedNodeImports(original, original, ['Hash'])).toBe(original);
  });

  it('drops one binding from each of two statements without overlap', () => {
    const original =
      "import { a } from 'node:fs';\nimport { c } from 'node:crypto';\nconst x = 1;\n";
    expect(dropUnusedNodeImports(original, original, ['a', 'c'])).toBe('const x = 1;\n');
  });

  it('drops both bindings of one statement in a single edit', () => {
    const original = "import { a, b } from 'node:fs';\nconst x = 1;\n";
    expect(dropUnusedNodeImports(original, original, ['a', 'b'])).toBe('const x = 1;\n');
  });

  it('handles an aliased import beside a live binding', () => {
    const original =
      "import { a } from 'node:fs';\nimport { a as a2 } from 'node:crypto';\nconst x = 1;\n";
    expect(dropUnusedNodeImports(original, original, ['a', 'a2'])).toBe('const x = 1;\n');
  });
});

describe('keepsNodePortable', () => {
  it('treats a Bun-global replacement as a one-way door', () => {
    expect(keepsNodePortable({ bunExpression: 'Bun.CryptoHasher' })).toBe(false);
    expect(keepsNodePortable({ bunExpression: 'Bun.gzipSync' })).toBe(false);
    expect(keepsNodePortable({ bunExpression: 'Bun.file' })).toBe(false);
  });

  it('treats a node: call Bun implements as portable', () => {
    expect(keepsNodePortable({ bunExpression: 'Array.prototype.toSorted' })).toBe(true);
  });
});

describe('portable = true in .bun-migrate.toml', () => {
  it('is off by default', () => {
    expect(loadProjectOverrides(undefined).portable).toBe(false);
    expect(loadProjectOverrides('auto-source = true').portable).toBe(false);
  });

  it('is on when the project opts in', () => {
    expect(loadProjectOverrides('portable = true').portable).toBe(true);
  });

  it('still parses when the line carries the comment the README example has', () => {
    const documented = [
      'deny = ["packages/browser-safe", "apps/extension"]   # never write Bun.* here',
      'auto-source = false                                   # skip the source layer',
      'portable = true                                       # only apply rewrites that still run on Node',
      '',
    ].join('\n');
    const parsed = loadProjectOverrides(documented);
    expect(parsed.portable).toBe(true);
    expect(parsed.allowSource).toBe(false);
    expect(JSON.stringify(parsed.deny)).toBe('["packages/browser-safe","apps/extension"]');
  });

  it('tolerates spacing around the equals sign', () => {
    expect(loadProjectOverrides('portable   =   true').portable).toBe(true);
    expect(loadProjectOverrides('portable=true').portable).toBe(true);
  });

  it('reads an array written across several lines', () => {
    const parsed = loadProjectOverrides('deny = [\n  "a",\n  "b",\n]\nportable = true');
    expect(JSON.stringify(parsed.deny)).toBe('["a","b"]');
    expect(parsed.portable).toBe(true);
  });

  it('does not treat a # inside a quoted string as a comment', () => {
    const parsed = loadProjectOverrides('deny = ["a#b"]\nportable = true');
    expect(JSON.stringify(parsed.deny)).toBe('["a#b"]');
  });

  it('distinguishes "not set" from "set to false"', () => {
    expect(loadProjectOverrides('portable = false').portable).toBe(false);
    expect(loadProjectOverrides('auto-source = true').allowSource).toBe(true);
    expect(loadProjectOverrides('auto-source = false').allowSource).toBe(false);
  });

  it('skips a Bun-only rewrite and says why', () => {
    const root = makeProject({
      'package.json': '{"name":"p","version":"1.0.0"}\n',
      '.bun-migrate.toml': 'portable = true\n',
      'src/a.js':
        "import { createHash } from 'node:crypto';\nexport const d = (t) => createHash('sha256').update(t).digest('hex');\n",
    });
    try {
      const journal = migrate(root, ['source']);
      expect(journal.changes.length).toBe(0);
      const reasons = journal
        .layers()
        .flatMap((layer) => layer.skipped)
        .map((item) => item.reason);
      expect(reasons.join(' ')).toContain('portable = true');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets the same rewrite through when the project does not opt in', () => {
    const root = makeProject({
      'package.json': '{"name":"p","version":"1.0.0"}\n',
      'src/a.js':
        "import { createHash } from 'node:crypto';\nexport const d = (t) => createHash('sha256').update(t).digest('hex');\n",
    });
    try {
      const journal = migrate(root, ['source']);
      const after = journal.changes.map((change) => change.after).join('\n');
      expect(after).toContain('Bun.CryptoHasher');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('disables every auto-applied source rule, which is all of them today', () => {
    const autoApplied = PAIRINGS.filter((pairing) => pairing.effect !== 'report-only');
    const portableOnes = autoApplied.filter((pairing) => keepsNodePortable(pairing));
    expect(`auto=${autoApplied.length > 0} portable=${portableOnes.length}`).toBe(
      `auto=true portable=${portableOnes.length}`,
    );
    expect(portableOnes.length).toBeLessThanOrEqual(autoApplied.length);
    for (const pairing of autoApplied) {
      if (portableOnes.includes(pairing)) continue;
      expect(pairing.bunExpression.includes('Bun.')).toBe(true);
    }
  });

  it('keeps the built-in deny list when the project adds its own entries', () => {
    const root = makeProject({
      'package.json': '{"name":"p","version":"1.0.0"}\n',
      '.bun-migrate.toml': 'deny = ["packages/mine"]\n',
      'packages/transcript/src/a.js':
        "import { gzipSync } from 'node:zlib';\nexport const a = (b) => gzipSync(b);\n",
      'src/ok.js': "import { gzipSync } from 'node:zlib';\nexport const a = (b) => gzipSync(b);\n",
    });
    try {
      const journal = migrate(root, ['source']);
      const touched = new Set(journal.changes.map((change) => change.file));
      expect(touched.has('packages/transcript/src/a.js')).toBe(false);
      expect(touched.has('src/ok.js')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * A migrated file must still parse.
 *
 * Every other case in this repo checks that a rewrite says what it claims. This
 * group checks the property that makes all of them worth anything: the output is
 * syntactically valid. It is the only check that caught the nested-edit splice
 * bug, where `gzipSync(gunzipSync(buf))` came out as
 * `Bun.gzipSync(gunzipSync(buf))uf));` and every per-layer assertion still passed.
 */
describe('a migrated file still parses', () => {
  const MIGRATION_CASES = [
    [
      'nested calls in one module',
      "import { gzipSync, gunzipSync } from 'node:zlib';\nexport const a = gzipSync(gunzipSync(buf));\n",
    ],
    [
      'three levels of nesting',
      "import { gzipSync, gunzipSync, inflateRawSync } from 'node:zlib';\nexport const a = gzipSync(gunzipSync(inflateRawSync(buf)));\n",
    ],
    [
      'nesting across modules',
      "import { createHash } from 'node:crypto';\nimport { gzipSync } from 'node:zlib';\nexport const a = gzipSync(createHash('sha256').update('x').digest());\n",
    ],
    [
      'a rewritten call beside a plain one',
      "import { gzipSync } from 'node:zlib';\nimport { readFileSync } from 'node:fs';\nexport const a = gzipSync(readFileSync('x'));\n",
    ],
    [
      'two calls on one line',
      "import { gzipSync } from 'node:zlib';\nexport const a = [gzipSync(x), gzipSync(y)];\n",
    ],
    [
      'a call inside a template literal argument',
      "import { gzipSync } from 'node:zlib';\nexport const a = gzipSync(`${'x'}`);\n",
    ],
    [
      'a call with a callback argument',
      "import { gzipSync } from 'node:zlib';\nexport const a = gzipSync([1, 2, 3].map((n) => n + 1));\n",
    ],
  ];

  for (const [label, source] of MIGRATION_CASES) {
    it(`parses after migration: ${label}`, () => {
      const root = makeProject({
        'package.json': '{"name":"p","version":"1.0.0","type":"module"}\n',
        'src/a.js': source,
      });
      try {
        migrate(root, ['source']);
        const after = readFileSync(join(root, 'src/a.js'), 'utf8');
        const parsed = parse('src/a.js', after);
        const diagnostics = parsed.parseDiagnostics ?? [];
        expect(`${label}: ${diagnostics.map((d) => d.messageText).join(' | ')}`).toBe(`${label}: `);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it('leaves no undefined identifier behind after a source rewrite', () => {
    const root = makeProject({
      'package.json': '{"name":"p","version":"1.0.0","type":"module"}\n',
      'src/a.js':
        "import { gzipSync } from 'node:zlib';\nexport const a = gzipSync(Buffer.from('x'));\n",
    });
    try {
      migrate(root, ['source']);
      const result = run(
        ['bun', '-e', "import('./src/a.js').then((m) => console.log(m.a.length > 0))"],
        root,
      );
      expect(result.stderr.trim()).toBe('');
      expect(result.stdout.trim()).toBe('true');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a migrated project still runs', () => {
  it('runs its tests through the rewritten script', () => {
    const root = makeProject({
      'package.json': `${JSON.stringify(
        {
          name: 'p',
          version: '1.0.0',
          type: 'module',
          scripts: { test: 'vitest run' },
          devDependencies: { vitest: '^2.0.0' },
        },
        null,
        2,
      )}\n`,
      'src/a.js': 'export const add = (a, b) => a + b;\n',
      'test/a.test.ts':
        "import { describe, expect, it } from 'vitest';\nimport { add } from '../src/a.js';\ndescribe('a', () => { it('adds', () => expect(add(1, 2)).toBe(3)); });\n",
    });
    try {
      migrate(root, ['config', 'tests']);
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(manifest.scripts.test).toBe('bun test');
      const result = run(['bun', 'run', 'test'], root);
      expect(result.stderr.includes('vitest')).toBe(false);
      expect(result.code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves no dead node: import behind after a source rewrite', () => {
    const root = makeProject({
      'package.json': '{"name":"p","version":"1.0.0","type":"module"}\n',
      'src/a.js':
        "import { createHash } from 'node:crypto';\nexport const d = (t) => createHash('sha256').update(t).digest('hex');\n",
    });
    try {
      migrate(root, ['source']);
      const after = readFileSync(join(root, 'src/a.js'), 'utf8');
      expect(after.includes("from 'node:crypto'")).toBe(false);
      const result = run(
        ['bun', '-e', "import('./src/a.js').then((m) => console.log(m.d('a').length))"],
        root,
      );
      expect(result.stdout.trim()).toBe('64');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the migrated code runnable under Node when portable = true', () => {
    if (!NODE_AVAILABLE) {
      expect(String(NODE_AVAILABLE)).toBe('node must be on PATH for the differential cases');
      return;
    }
    const root = makeProject({
      'package.json': '{"name":"p","version":"1.0.0","type":"module"}\n',
      '.bun-migrate.toml': 'portable = true\n',
      'src/a.js':
        "import { createHash } from 'node:crypto';\nexport const d = (t) => createHash('sha256').update(t).digest('hex');\n",
    });
    try {
      migrate(root, ['source']);
      const result = run(
        ['node', '-e', "import('./src/a.js').then((m) => console.log(m.d('a').length))"],
        root,
      );
      expect(result.stderr.includes('Bun is not defined')).toBe(false);
      expect(result.stdout.trim()).toBe('64');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
