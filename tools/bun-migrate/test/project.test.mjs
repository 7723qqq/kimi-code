import { afterEach, describe, expect, it } from 'bun:test';
/**
 * Whole-project behaviour: a legacy pnpm project goes in, an equivalent Bun
 * project comes out, and the journal can undo it.
 *
 * Every fixture is created in a temp directory and removed afterwards; nothing
 * here writes into the repository.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli.mjs');
const created = [];

function makeProject(files) {
  const root = mkdtempSync(join(tmpdir(), 'bun-migrate-proj-'));
  created.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  return root;
}

function run(...args) {
  const result = Bun.spawnSync(['bun', CLI, ...args], {
    cwd: join(import.meta.dir, '..', '..', '..'),
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

const LEGACY = {
  'package.json': `${JSON.stringify(
    {
      name: 'legacy',
      version: '1.0.0',
      scripts: { build: 'pnpm -r build', lint: 'npx eslint .' },
      engines: { node: '>=20' },
    },
    null,
    2,
  )}\n`,
  'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
  'pnpm-lock.yaml': 'lockfileVersion: 5.4\n',
  '.npmrc': 'registry=https://example.test\n',
  '.nvmrc': '20.11.0\n',
  'vitest.config.ts': 'export default {};\n',
  'src/hash.ts':
    "import { createHash } from 'node:crypto';\nexport const f = () => createHash('sha256').update('a').digest('hex');\n",
  'src/hash.test.ts':
    "import { describe, it, expect } from 'vitest';\nimport { f } from './hash';\ndescribe('f', () => { it('works', () => { expect(f()).toBeTruthy(); }); });\n",
};

afterEach(() => {
  for (const root of created.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('apply on a legacy pnpm project', () => {
  it('writes the migrated shape and removes what Bun replaces', () => {
    const root = makeProject(LEGACY);
    const result = run('apply', '--root', root, '--allow-dirty');
    expect(result.code).toBe(0);

    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(manifest.packageManager).toBe(`bun@${Bun.version}`);
    expect(manifest.engines).toBeUndefined();
    expect(manifest.scripts.build).toBe('bun run --filter "*" build');
    expect(manifest.scripts.lint).toBe('bunx eslint .');
    expect(manifest.workspaces.packages).toContain('packages/*');

    expect(readFileSync(join(root, 'src/hash.ts'), 'utf8')).toContain('Bun.CryptoHasher');
    expect(readFileSync(join(root, 'src/hash.test.ts'), 'utf8')).toContain("from 'bun:test'");
    expect(readFileSync(join(root, 'src/hash.test.ts'), 'utf8')).toContain('expect');

    expect(existsSync(join(root, '.npmrc'))).toBe(false);
    expect(existsSync(join(root, '.nvmrc'))).toBe(false);
    expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(false);
    expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(false);
    expect(existsSync(join(root, 'vitest.config.ts'))).toBe(false);
  });

  it('writes a journal that revert restores from', () => {
    const root = makeProject(LEGACY);
    const before = readFileSync(join(root, 'src/hash.ts'), 'utf8');
    expect(run('apply', '--root', root, '--allow-dirty').code).toBe(0);
    const journalDir = join(root, '.bun-migrate');
    const json = readdirName(journalDir, '.json');
    expect(json).toBeDefined();
    expect(run('revert', '--root', root, join(journalDir, json)).code).toBe(0);
    expect(readFileSync(join(root, 'src/hash.ts'), 'utf8')).toBe(before);
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(manifest.scripts.build).toBe('pnpm -r build');
  });

  it('scan writes nothing', () => {
    const root = makeProject(LEGACY);
    const result = run('scan', '--root', root);
    expect(result.code).toBe(0);
    expect(existsSync(join(root, '.npmrc'))).toBe(true);
    expect(readFileSync(join(root, 'src/hash.ts'), 'utf8')).toContain('createHash(');
    expect(existsSync(join(root, '.bun-migrate'))).toBe(false);
  });
});

describe('per-project exceptions', () => {
  it('honours deny so browser-safe packages keep node: calls', () => {
    const root = makeProject({
      ...LEGACY,
      '.bun-migrate.toml': 'deny = ["packages/browser"]\n',
      'packages/browser/src/h.ts':
        "import { createHash } from 'node:crypto';\nexport const g = () => createHash('sha256');\n",
    });
    expect(run('apply', '--root', root, '--allow-dirty').code).toBe(0);
    expect(readFileSync(join(root, 'packages/browser/src/h.ts'), 'utf8')).toContain('createHash(');
    expect(readFileSync(join(root, 'src/hash.ts'), 'utf8')).toContain('Bun.CryptoHasher');
  });

  it('honours auto-source = false by leaving all node: calls alone', () => {
    const root = makeProject({
      ...LEGACY,
      '.bun-migrate.toml': 'auto-source = false\n',
    });
    expect(run('apply', '--root', root, '--allow-dirty').code).toBe(0);
    expect(readFileSync(join(root, 'src/hash.ts'), 'utf8')).toContain('createHash(');
  });

  it('honours deny for package and test rewrites as well as source', () => {
    const root = makeProject({
      ...LEGACY,
      '.bun-migrate.toml': 'deny = ["packages/browser"]\n',
      'package.json': `${JSON.stringify(
        {
          name: 'legacy',
          version: '1.0.0',
          dependencies: { yaml: '^2.0.0' },
        },
        null,
        2,
      )}\n`,
      'packages/browser/src/a.ts':
        "import { parse } from 'yaml';\nexport const a = parse('a: 1');\n",
      'packages/browser/test/a.test.ts':
        "import { describe, it, expect } from 'vitest';\ndescribe('a', () => { it('b', () => expect(1).toBe(1)); });\n",
    });
    try {
      expect(run('apply', '--root', root, '--allow-dirty').code).toBe(0);
      expect(readFileSync(join(root, 'packages/browser/src/a.ts'), 'utf8')).toContain(
        "import { parse } from 'yaml'",
      );
      expect(readFileSync(join(root, 'packages/browser/test/a.test.ts'), 'utf8')).toContain(
        "from 'vitest'",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('honours portable = true for package and test rewrites as well as source', () => {
    const root = makeProject({
      ...LEGACY,
      '.bun-migrate.toml': 'portable = true\n',
      'package.json': `${JSON.stringify(
        {
          name: 'legacy',
          version: '1.0.0',
          dependencies: { yaml: '^2.0.0' },
        },
        null,
        2,
      )}\n`,
      'src/yaml.ts': "import { parse } from 'yaml';\nexport const a = parse('a: 1');\n",
      'src/yaml.test.ts':
        "import { describe, it, expect } from 'vitest';\ndescribe('a', () => { it('b', () => expect(1).toBe(1)); });\n",
    });
    try {
      expect(run('apply', '--root', root, '--allow-dirty').code).toBe(0);
      expect(readFileSync(join(root, 'src/yaml.ts'), 'utf8')).toContain(
        "import { parse } from 'yaml'",
      );
      expect(readFileSync(join(root, 'src/yaml.test.ts'), 'utf8')).toContain("from 'vitest'");
      expect(readFileSync(join(root, 'src/hash.ts'), 'utf8')).toContain('createHash(');
      expect(existsSync(join(root, 'vitest.config.ts'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('project loading tolerates an unrelated broken manifest', () => {
  it('does not abort the run because a nested package.json is malformed', () => {
    const root = makeProject({
      ...LEGACY,
      'packages/broken/package.json': '{ not json',
      'packages/broken/src/x.ts':
        "import { createHash } from 'node:crypto';\nexport const x = createHash('sha256');\n",
    });
    try {
      const result = run('scan', '--root', root);
      expect(result.code).toBe(0);
      expect(result.out).toContain('src/hash.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the journal warns when it records credentials', () => {
  it('names .bun-migrate when the project does not ignore it', () => {
    const root = makeProject(LEGACY);
    try {
      const result = run('apply', '--root', root, '--allow-dirty');
      expect(result.code).toBe(0);
      expect(result.err).toContain('.bun-migrate');
      expect(result.err).toContain('git-ignored');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('safety rails', () => {
  it('reports a non-literal algorithm instead of rewriting it', () => {
    const root = makeProject({
      ...LEGACY,
      'src/dyn.ts':
        "import { createHash } from 'node:crypto';\nexport const h = (alg: string) => createHash(alg);\n",
    });
    const result = run('scan', '--root', root);
    expect(result.out).toContain('not a string literal');
  });

  /**
   * A migration outside git cannot be diffed, which is the same property the
   * dirty-tree guard protects. Measured before this case: `apply` in a plain
   * directory wrote every file and exited 0, because `gitIsDirty` returned
   * `undefined` on git failure and the check compared `=== true`.
   */
  it('refuses to apply in a directory that is not a git repository', () => {
    const root = makeProject({
      'package.json': '{"name":"n","version":"1.0.0"}\n',
      'src/a.ts':
        "import { createHash } from 'node:crypto';\nexport const a = createHash('sha256').update('x').digest('hex');\n",
    });
    try {
      const refused = run('apply', '--root', root);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('not a git repository');
      expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toContain('createHash(');
      expect(existsSync(join(root, '.bun-migrate'))).toBe(false);

      const allowed = run('apply', '--root', root, '--allow-dirty');
      expect(allowed.code).toBe(0);
      expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toContain('Bun.CryptoHasher');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports writeFile as measured-slower rather than rewriting it', () => {
    const root = makeProject({
      ...LEGACY,
      'src/raw.ts':
        "import { writeFile } from 'node:fs/promises';\nexport const w = (p: string, v: string) => writeFile(p, v);\n",
    });
    const result = run('scan', '--root', root);
    expect(result.out).toContain('writeFile');
    const migrated = readFileSync(join(root, 'src/raw.ts'), 'utf8');
    expect(migrated).toContain('writeFile(');
  });
});

describe('test layer keeps the file runnable', () => {
  it('rewrites vi.fn to mock and imports mock', () => {
    const root = makeProject({
      'package.json': '{"name":"t","version":"1.0.0"}\n',
      'src/a.test.ts': [
        "import { describe, it, expect, vi } from 'vitest';",
        '',
        "describe('a', () => { it('calls', () => {",
        '  const fn = vi.fn(() => 42);',
        '  expect(fn()).toBe(42);',
        '}); });',
        '',
      ].join('\n'),
    });
    expect(run('apply', '--root', root, '--allow-dirty').code).toBe(0);
    const migrated = readFileSync(join(root, 'src/a.test.ts'), 'utf8');
    expect(migrated).toContain("from 'bun:test'");
    expect(migrated).toContain('mock(() => 42)');
    expect(migrated).not.toContain('vi.fn');
    expect(migrated).toContain('mock');
    expect(/\bmock\b/.test(migrated.split('\n')[0])).toBe(true);
  });

  it('produces a test file bun test can actually run', () => {
    const root = makeProject({
      'package.json': '{"name":"t","version":"1.0.0"}\n',
      'src/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
      'src/a.test.ts': [
        "import { describe, it, expect, vi } from 'vitest';",
        "import { add } from './math';",
        '',
        "describe('add', () => { it('sums', () => {",
        '  const spy = vi.fn(() => 42);',
        '  expect(add(1, 2)).toBe(3);',
        '  expect(spy()).toBe(42);',
        '}); });',
        '',
      ].join('\n'),
    });
    expect(run('apply', '--root', root, '--allow-dirty').code).toBe(0);
    const result = Bun.spawnSync(['bun', 'test'], { cwd: root });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(output).toContain('1 pass');
    expect(result.exitCode).toBe(0);
  });

  it('never consumes characters around the rewritten call', () => {
    const root = makeProject({
      'package.json': '{"name":"t","version":"1.0.0"}\n',
      'src/b.test.ts': [
        "import { it, expect, vi } from 'vitest';",
        "it('x', () => { const f = vi.fn(() => 1); expect(f()).toBe(1); });",
        '',
      ].join('\n'),
    });
    expect(run('apply', '--root', root, '--allow-dirty').code).toBe(0);
    const migrated = readFileSync(join(root, 'src/b.test.ts'), 'utf8');
    expect(migrated).toContain('const f = mock(() => 1);');
    expect(migrated).toContain('expect(f()).toBe(1);');
    expect(migrated).not.toContain('vimock');
  });
});

function readdirName(directory, suffix) {
  if (!existsSync(directory)) return undefined;
  return readdirSync(directory).find((name) => name.endsWith(suffix));
}
