import { describe, expect, it } from 'bun:test';
/**
 * Regressions found by running the tool against a real upstream checkout.
 *
 * Each case here broke a whole-project migration in a way no unit test had
 * caught: a package manager left behind, a catalog entry lost, a script Bun
 * cannot resolve. They are kept as whole-project tests because the failure only
 * appears after every layer has run in order.
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

function makeProject(files) {
  const root = mkdtempSync(join(tmpdir(), 'upstream-'));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  return root;
}

function apply(root) {
  const result = Bun.spawnSync(['bun', CLI, 'apply', '--root', root, '--allow-dirty'], {
    cwd: join(import.meta.dir, '..', '..', '..'),
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

/** The shape a real pnpm monorepo has when the tool first meets it. */
const PNPM_MONOREPO = {
  'package.json': `${JSON.stringify(
    {
      name: 'root',
      version: '1.0.0',
      packageManager: 'pnpm@10.33.0',
      scripts: {
        build: 'pnpm -r run build',
        'build:packages': "pnpm -r --filter './packages/*' run build",
        'dev:cli': 'pnpm -C apps/kimi-code run dev',
        test: 'pnpm run pretest && vitest run',
        lint: 'npx eslint .',
      },
      dependencies: { zod: 'catalog:' },
    },
    null,
    2,
  )}\n`,
  'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - 'apps/*'\ncatalog:\n  zod: 4.3.6\n",
  'pnpm-lock.yaml': 'lockfileVersion: 5.4\n',
  '.npmrc': 'registry=https://example.test\n',
  '.nvmrc': '20.11.0\n',
  'packages/a/package.json': `${JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { zod: 'catalog:' } }, null, 2)}\n`,
  'packages/a/src/x.ts':
    "import { createHash } from 'node:crypto';\nexport const x = createHash('sha256').update('a').digest('hex');\n",
};

describe('package manager is replaced, not just added', () => {
  it('overwrites an existing pnpm packageManager with bun', () => {
    const root = makeProject(PNPM_MONOREPO);
    try {
      expect(apply(root).code).toBe(0);
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(manifest.packageManager).toBe(`bun@${Bun.version}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records the previous package manager so the change is reviewable', () => {
    const root = makeProject(PNPM_MONOREPO);
    try {
      apply(root);
      const journalDir = join(root, '.bun-migrate');
      const name = readdirSync(journalDir)
        .filter((item) => item.endsWith('.md'))
        .toSorted()
        .pop();
      const markdown = readFileSync(join(journalDir, name), 'utf8');
      expect(markdown).toContain('pnpm@10.33.0');
      expect(markdown).toContain(`bun@${Bun.version}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('pnpm catalog survives the workspace removal', () => {
  it('moves catalog entries into workspaces.catalog', () => {
    const root = makeProject(PNPM_MONOREPO);
    try {
      expect(apply(root).code).toBe(0);
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(manifest.workspaces.catalog).toEqual({ zod: '4.3.6' });
      expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the workspace globs alongside the catalog', () => {
    const root = makeProject(PNPM_MONOREPO);
    try {
      expect(apply(root).code).toBe(0);
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(manifest.workspaces.packages).toEqual(['packages/*', 'apps/*']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves a catalog: dependency resolvable after the move', () => {
    const root = makeProject(PNPM_MONOREPO);
    try {
      expect(apply(root).code).toBe(0);
      const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      const memberManifest = JSON.parse(
        readFileSync(join(root, 'packages/a/package.json'), 'utf8'),
      );
      expect(rootManifest.dependencies.zod).toBe('catalog:');
      expect(memberManifest.dependencies.zod).toBe('catalog:');
      expect(rootManifest.workspaces.catalog.zod).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('scripts become commands Bun can actually run', () => {
  it('rewrites pnpm -r run without leaving a doubled run', () => {
    const root = makeProject(PNPM_MONOREPO);
    try {
      expect(apply(root).code).toBe(0);
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(manifest.scripts.build).toBe('bun run --filter "*" build');
      expect(manifest.scripts.build.includes('run run')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites pnpm -r --filter', () => {
    const root = makeProject(PNPM_MONOREPO);
    try {
      apply(root);
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(manifest.scripts['build:packages']).toContain('bun run --filter');
      expect(manifest.scripts['build:packages']).not.toContain('pnpm');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites pnpm -C into a directory change', () => {
    const root = makeProject(PNPM_MONOREPO);
    try {
      apply(root);
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(manifest.scripts['dev:cli']).toBe('cd apps/kimi-code && bun run dev');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves no pnpm or npx token in any script', () => {
    const root = makeProject(PNPM_MONOREPO);
    try {
      apply(root);
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      for (const [name, command] of Object.entries(manifest.scripts)) {
        const script = typeof command === 'string' ? command : JSON.stringify(command);
        const shape = `${name} = ${script}`;
        expect(`${shape} pnpm=${/\bpnpm\b/.test(script)}`).toBe(`${shape} pnpm=false`);
        expect(`${shape} npx=${/\bnpx\b/.test(script)}`).toBe(`${shape} npx=false`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a monorepo member declares the dependency, not the root', () => {
  it('still rewrites a package that only the member depends on', () => {
    const root = makeProject({
      'package.json': '{"name":"root","version":"1.0.0"}\n',
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'packages/a/package.json':
        '{"name":"a","version":"1.0.0","dependencies":{"yaml":"^2.0.0"}}\n',
      'packages/a/src/x.ts': "import { parse } from 'yaml';\nexport const x = parse('a: 1');\n",
    });
    try {
      expect(apply(root).code).toBe(0);
      const migrated = readFileSync(join(root, 'packages/a/src/x.ts'), 'utf8');
      expect(migrated).toContain('Bun.YAML.parse');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not rewrite when no manifest declares the package', () => {
    const root = makeProject({
      'package.json': '{"name":"root","version":"1.0.0"}\n',
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'packages/a/package.json': '{"name":"a","version":"1.0.0"}\n',
      'packages/a/src/x.ts': "import { parse } from 'yaml';\nexport const x = parse('a: 1');\n",
    });
    try {
      apply(root);
      expect(readFileSync(join(root, 'packages/a/src/x.ts'), 'utf8')).toContain('parse(');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
