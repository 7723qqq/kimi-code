/**
 * Package replacement: dropping an npm dependency in favour of a Bun builtin.
 *
 * This layer carries more risk than the node: builtins one, because the failure
 * mode is a missing API rather than a changed call shape. A partial migration
 * leaves the import removed and the call unresolved, which fails at run time
 * rather than at build time. Every test here is about preventing that.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { collectPackageBindings, parse } from '../src/ast.mjs';
import { createJournal } from '../src/journal.mjs';
import { applyPackageReplacementLayer } from '../src/layers/package-replacement.mjs';
import { assessImport, PACKAGE_REPLACEMENTS, replacementFor } from '../src/packages-map.mjs';
import { loadProject } from '../src/project.mjs';

function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'pkg-'));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  return root;
}

function migrate(files) {
  const root = project(files);
  try {
    const loaded = loadProject(root);
    const journal = createJournal(['packages']);
    applyPackageReplacementLayer(loaded, journal);
    const out = {};
    for (const change of journal.changes) {
      if (change.kind === 'note') {
        out.notes = `${out.notes ?? ''}${change.detail}\n`;
        continue;
      }
      out[change.file] = change.after;
      out[`detail:${change.file}`] = change.detail;
    }
    for (const skipped of journal.layers().flatMap((layer) => layer.skipped)) {
      out[`skip:${skipped.file}`] = skipped.reason;
    }
    return out;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const MANIFEST = (deps) => `${JSON.stringify({ name: 'p', version: '1.0.0', dependencies: deps }, null, 2)}\n`;

/**
 * Removing the import is part of the rewrite: leaving it behind keeps the dependency
 * in the module graph and makes the diff claim the file still needs it.
 *
 * Two defects lived here. `collectPackageBindings` located a statement by searching
 * for its first line of text, so two wrapped imports that both begin `import {`
 * resolved to the same line. And `removeImport` matched a single-line clause with a
 * regex, so a wrapped import was not removed at all — measured, the call became
 * `Bun.YAML.parse` while `import { parse, } from 'yaml'` stayed on three lines above
 * it, with nothing in the output saying the removal was skipped.
 */
describe('the rewritten import is removed in every layout', () => {
  const DEPS = { yaml: '^2.0.0' };

  it('removes a single-line named import', () => {
    const output = migrate({
      'package.json': MANIFEST(DEPS),
      'src/a.js': "import { parse } from 'yaml';\nexport const a = (t) => parse(t);\n",
    });
    expect(output['src/a.js'].includes("from 'yaml'")).toBe(false);
    expect(output['src/a.js']).toContain('Bun.YAML.parse');
  });

  it('removes a wrapped named import', () => {
    const output = migrate({
      'package.json': MANIFEST(DEPS),
      'src/a.js': "import {\n  parse,\n} from 'yaml';\nexport const a = (t) => parse(t);\n",
    });
    expect(output['src/a.js'].includes("from 'yaml'")).toBe(false);
    expect(output['src/a.js']).toContain('Bun.YAML.parse');
  });

  it('removes both of two wrapped imports that start on the same text', () => {
    const output = migrate({
      'package.json': MANIFEST(DEPS),
      'src/a.js': [
        'import {',
        '  parse,',
        "} from 'yaml';",
        'import {',
        '  stringify,',
        "} from 'yaml';",
        'export const a = (t) => parse(t);',
        'export const b = (v) => stringify(v);',
        '',
      ].join('\n'),
    });
    expect(output['src/a.js'].includes("from 'yaml'")).toBe(false);
    expect(output['src/a.js']).toContain('Bun.YAML.parse');
    expect(output['src/a.js']).toContain('Bun.YAML.stringify');
  });

  it('keeps a default binding beside a removed named one', () => {
    const output = migrate({
      'package.json': MANIFEST(DEPS),
      'src/a.js': "import yaml, { parse } from 'yaml';\nexport const a = (t) => parse(t);\nexport const b = yaml;\n",
    });
    expect(output['src/a.js']).toContain("import yaml from 'yaml';");
    expect(output['src/a.js'].includes('{ parse }')).toBe(false);
    expect(output['src/a.js']).toContain('Bun.YAML.parse');
  });

  it('reports a distinct line for each wrapped import', () => {
    const sourceFile = parse(
      'a.mjs',
      ['import {', '  parse,', "} from 'yaml';", 'import {', '  stringify,', "} from 'yaml';", ''].join('\n'),
    );
    const bindings = collectPackageBindings(sourceFile);
    expect(bindings.get('parse').statementLine).toBe(0);
    expect(bindings.get('stringify').statementLine).toBe(3);
  });

  it('still parses after the removal', () => {
    const output = migrate({
      'package.json': MANIFEST({ yaml: '^2.0.0', 'js-yaml': '^4.0.0' }),
      'src/a.js': [
        'import {',
        '  parse,',
        "} from 'yaml';",
        "import { load } from 'js-yaml';",
        'export const a = (t) => parse(t);',
        'export const b = (t) => load(t);',
        '',
      ].join('\n'),
    });
    const parsed = parse('src/a.js', output['src/a.js']);
    const diagnostics = parsed.parseDiagnostics ?? [];
    expect(diagnostics.map((diagnostic) => diagnostic.messageText).join(' | ')).toBe('');
  });
});

describe('binding collection', () => {
  it('records a named import with its local name', () => {
    const sourceFile = parse('a.ts', "import { parse, stringify } from 'yaml';\n");
    const bindings = collectPackageBindings(sourceFile);
    expect(bindings.get('parse')?.imported).toBe('parse');
    expect(bindings.get('parse')?.package).toBe('yaml');
    expect(bindings.get('stringify')?.imported).toBe('stringify');
  });

  it('records a default import', () => {
    const sourceFile = parse('a.ts', "import stripAnsi from 'strip-ansi';\n");
    const bindings = collectPackageBindings(sourceFile);
    expect(bindings.get('stripAnsi')?.imported).toBe('default');
  });

  it('records an aliased named import under the local name', () => {
    const sourceFile = parse('a.ts', "import { parse as parseToml } from 'smol-toml';\n");
    const bindings = collectPackageBindings(sourceFile);
    expect(bindings.get('parseToml')?.imported).toBe('parse');
  });

  it('ignores relative, node: and bun: imports', () => {
    const sourceFile = parse(
      'a.ts',
      "import a from './a';\nimport b from 'node:fs';\nimport c from 'bun:test';\nimport d from 'yaml';\n",
    );
    const bindings = collectPackageBindings(sourceFile);
    expect([...bindings.keys()]).toEqual(['d']);
  });
});

describe('safety assessment', () => {
  it('passes a package whose whole surface is verified', () => {
    const verdict = assessImport('smol-toml', ['parse']);
    expect(verdict.safe).toBe(true);
    expect(verdict.unverified).toEqual([]);
  });

  it('refuses a named import that Bun does not implement', () => {
    const verdict = assessImport('semver', ['sort']);
    expect(verdict.safe).toBe(false);
    expect(verdict.unverified).toEqual(['sort']);
  });

  it('refuses a partial package so the import cannot be half-removed', () => {
    const verdict = assessImport('semver', ['satisfies']);
    expect(verdict.safe).toBe(false);
    expect(verdict.replacement.effect).toBe('report-only');
  });

  it('refuses a package Bun has no replacement for', () => {
    expect(assessImport('lodash', ['map'])).toBeUndefined();
    expect(replacementFor('lodash')).toBeUndefined();
  });

  it('every replacement lists what it verified and what it cannot do', () => {
    for (const entry of PACKAGE_REPLACEMENTS) {
      expect(Array.isArray(entry.verified)).toBe(true);
      expect(entry.caveats.length).toBeGreaterThan(10);
      expect(entry.summary.length).toBeGreaterThan(10);
      if (entry.verified.length === 0) {
        expect(entry.effect).toBe('report-only');
      }
    }
  });
});

describe('rewriting a whole file', () => {
  it('rewrites every call and removes the emptied import', () => {
    const output = migrate({
      'package.json': MANIFEST({ yaml: '^2.0.0' }),
      'src/a.ts': [
        "import { parse, stringify } from 'yaml';",
        "export const a = parse('x: 1');",
        'export const b = stringify({ x: 1 });',
        '',
      ].join('\n'),
    });
    expect(output['src/a.ts']).toContain('Bun.YAML.parse');
    expect(output['src/a.ts']).toContain('Bun.YAML.stringify');
    expect(output['src/a.ts']).not.toContain("from 'yaml'");
  });

  it('keeps the members of a shared import that were not rewritten', () => {
    const output = migrate({
      'package.json': MANIFEST({ semver: '^7.0.0', yaml: '^2.0.0' }),
      'src/a.ts': [
        "import { parse } from 'yaml';",
        "import { satisfies } from 'semver';",
        'export const a = parse(\'x: 1\');',
        "export const b = satisfies('1.0.0', '^1.0.0');",
        '',
      ].join('\n'),
    });
    expect(output['src/a.ts']).toContain('Bun.YAML.parse');
    expect(output['src/a.ts']).toContain('satisfies');
    expect(output['skip:src/a.ts']).toContain('semver');
  });

  it('leaves a dependency that is not in package.json alone', () => {
    const output = migrate({
      'package.json': MANIFEST({}),
      'src/a.ts': "import { parse } from 'yaml';\nexport const a = parse('x: 1');\n",
    });
    expect(output['src/a.ts']).toBeUndefined();
  });

  it('leaves a package Bun cannot replace at all', () => {
    const output = migrate({
      'package.json': MANIFEST({ lodash: '^4.0.0' }),
      'src/a.ts': "import { map } from 'lodash';\nexport const a = map([1], (x) => x);\n",
    });
    expect(output['src/a.ts']).toBeUndefined();
  });

  it('does not touch a local function that shadows the import name', () => {
    const output = migrate({
      'package.json': MANIFEST({ yaml: '^2.0.0' }),
      'src/a.ts': 'export const parse = (x: string) => x;\nexport const b = parse("y");\n',
    });
    expect(output['src/a.ts']).toBeUndefined();
  });
});

describe('the rewritten code actually runs', () => {
  it('produces a file Bun can execute end to end', () => {
    const root = project({
      'package.json': MANIFEST({ yaml: '^2.0.0', 'smol-toml': '^1.0.0', 'strip-ansi': '^7.0.0', 'json5': '^2.0.0' }),
      'src/a.ts': [
        "import { parse as yamlParse } from 'yaml';",
        "import { parse as tomlParse } from 'smol-toml';",
        "import { parse as json5Parse } from 'json5';",
        "import stripAnsi from 'strip-ansi';",
        "export const y = yamlParse('a: 1');",
        "export const t = tomlParse('b = 2');",
        "export const j = json5Parse('{ c: 3 }');",
        "export const s = stripAnsi('\\u001B[31mz\\u001B[0m');",
        '',
      ].join('\n'),
    });
    try {
      const loaded = loadProject(root);
      const journal = createJournal(['packages']);
      applyPackageReplacementLayer(loaded, journal);
      journal.commit(root);

      const runner = join(root, 'run.ts');
      writeFileSync(
        runner,
        [
          "import { y, t, j, s } from './src/a.ts';",
          "console.log(JSON.stringify({ y, t, j, s }));",
          '',
        ].join('\n'),
        'utf8',
      );
      const result = Bun.spawnSync(['bun', runner], { cwd: root });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.toString().trim());
      expect(parsed.y).toEqual({ a: 1 });
      expect(parsed.t).toEqual({ b: 2 });
      expect(parsed.j).toEqual({ c: 3 });
      expect(parsed.s).toBe('z');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('reporting', () => {
  it('names every package that lost its last importer', () => {
    const output = migrate({
      'package.json': MANIFEST({ yaml: '^2.0.0' }),
      'src/a.ts': "import { parse } from 'yaml';\nexport const a = parse('x: 1');\n",
    });
    expect(output.notes).toContain('yaml');
    expect(output.notes).toContain('Bun.YAML');
  });

  it('writes nothing when no replacement applies', () => {
    const root = project({
      'package.json': MANIFEST({ lodash: '^4.0.0' }),
      'src/a.ts': "import { map } from 'lodash';\nexport const a = map([1], (x) => x);\n",
    });
    try {
      const before = readFileSync(join(root, 'src/a.ts'), 'utf8');
      const loaded = loadProject(root);
      const journal = createJournal(['packages']);
      applyPackageReplacementLayer(loaded, journal);
      journal.commit(root);
      expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The package layer used to rewrite every call with a matching identifier. A
 * parameter or local function of that name is not the imported binding, so the
 * rewrite reached a different function while the diff looked like a rename.
 * The source layer already refused this; the package layer did not.
 */
describe('a shadowed package binding is never rewritten', () => {
  it('leaves a parameter that shadows the import alone and says why', () => {
    const output = migrate({
      'package.json': MANIFEST({ yaml: '^2.0.0' }),
      'src/a.ts': [
        "import { parse } from 'yaml';",
        'export function f(parse: (s: string) => string) { return parse("yaml: 1"); }',
        "export const outside = parse('a: 1');",
        '',
      ].join('\n'),
    });
    expect(output['src/a.ts']).toBeUndefined();
    expect(output['skip:src/a.ts']).toContain('shadows');
  });

  it('reports a namespace import instead of silently doing nothing', () => {
    const output = migrate({
      'package.json': MANIFEST({ yaml: '^2.0.0' }),
      'src/a.ts': "import * as yaml from 'yaml';\nexport const a = yaml.parse('a: 1');\n",
    });
    expect(output['src/a.ts']).toBeUndefined();
    expect(output['skip:src/a.ts']).toContain('namespace import');
  });
});

describe('portable and deny apply to package replacements too', () => {
  it('portable = true leaves a Bun-only replacement alone', () => {
    const output = migrate({
      '.bun-migrate.toml': 'portable = true\n',
      'package.json': MANIFEST({ yaml: '^2.0.0' }),
      'src/a.ts': "import { parse } from 'yaml';\nexport const a = parse('a: 1');\n",
    });
    expect(output['src/a.ts']).toBeUndefined();
    expect(output['skip:src/a.ts']).toContain('portable = true');
  });

  it('deny leaves a browser package untouched', () => {
    const output = migrate({
      '.bun-migrate.toml': 'deny = ["packages/browser"]\n',
      'package.json': MANIFEST({ yaml: '^2.0.0' }),
      'packages/browser/src/a.ts': "import { parse } from 'yaml';\nexport const a = parse('a: 1');\n",
    });
    expect(output['packages/browser/src/a.ts']).toBeUndefined();
    expect(Object.keys(output).some((key) => key.startsWith('skip:'))).toBe(false);
  });
});

describe('which.sync maps to Bun.which, which takes the command directly', () => {
  it('produces a call that runs', () => {
    const root = project({
      'package.json': MANIFEST({ which: '^4.0.0' }),
      'src/a.js': "import { sync } from 'which';\nexport const a = sync('bun');\n",
    });
    try {
      const loaded = loadProject(root);
      const journal = createJournal(['packages']);
      applyPackageReplacementLayer(loaded, journal);
      journal.commit(root);
      const migrated = readFileSync(join(root, 'src/a.js'), 'utf8');
      expect(migrated).toContain('Bun.which(');
      expect(migrated.includes('Bun.which.sync')).toBe(false);
      const result = Bun.spawnSync(['bun', '-e', "import('./src/a.js').then((m) => console.log(m.a))"], {
        cwd: root,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim().length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
