import { describe, expect, it } from 'bun:test';
/**
 * Revert must restore every kind of change, including deleted files.
 *
 * A previous version recorded only the path of a removed file, so `revert`
 * printed a note and left the file gone. That is worse than not having revert at
 * all, because it looks like it worked. These tests pin the content round trip.
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
  const root = mkdtempSync(join(tmpdir(), 'revert-'));
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
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function newestJournal(root, suffix) {
  const directory = join(root, '.bun-migrate');
  if (!existsSync(directory)) return undefined;
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(suffix))
    .toSorted();
  const last = names.at(-1);
  return last ? join(directory, last) : undefined;
}

const LEGACY = {
  'package.json': `${JSON.stringify({ name: 'r', version: '1.0.0', scripts: { build: 'pnpm -r build' } }, null, 2)}\n`,
  '.npmrc': 'registry=https://example.test\n',
  '.nvmrc': '20.11.0\n',
  'pnpm-lock.yaml': 'lockfileVersion: 5.4\n',
  'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
  'vitest.config.ts':
    "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['src/**/*.test.ts'] } });\n",
  'src/a.ts':
    "import { createHash } from 'node:crypto';\nexport const a = createHash('sha256').update('x').digest('hex');\n",
};

describe('revert restores removed files', () => {
  it('brings back a deleted config file byte for byte', () => {
    const root = makeProject(LEGACY);
    try {
      const before = readFileSync(join(root, 'vitest.config.ts'), 'utf8');
      const apply = run('apply', '--root', root, '--allow-dirty');
      expect(apply.code).toBe(0);
      expect(existsSync(join(root, 'vitest.config.ts'))).toBe(false);

      const journal = newestJournal(root, '.json');
      expect(journal).toBeDefined();
      const revert = run('revert', '--root', root, journal);
      expect(revert.code).toBe(0);
      expect(existsSync(join(root, 'vitest.config.ts'))).toBe(true);
      expect(readFileSync(join(root, 'vitest.config.ts'), 'utf8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * A manifest migration used to record `JSON.stringify(manifest, null, 2)` as
   * the journal's `before`, so a package.json written in any other whitespace
   * came back reformatted — measured, a single-line manifest reverted to five
   * lines and `git status` still reported it modified. Revert has to restore
   * the disk bytes, not the migration's preferred formatting.
   */
  it('restores a reformatted package.json byte for byte', () => {
    const root = makeProject({
      'package.json':
        '{ "name": "r", "version": "1.0.0", "scripts": { "build": "pnpm -r build" } }\n',
    });
    try {
      const before = readFileSync(join(root, 'package.json'), 'utf8');
      expect(before.includes('\n  ')).toBe(false);
      expect(run('apply', '--root', root, '--allow-dirty').code).toBe(0);
      expect(readFileSync(join(root, 'package.json'), 'utf8')).not.toBe(before);
      const journal = newestJournal(root, '.json');
      expect(run('revert', '--root', root, journal).code).toBe(0);
      expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The packages layer writes the timeout preload through `journal.set` with no
   * pre-image, so the journal carries it as an edit whose `before` is undefined.
   * Revert used to skip exactly that shape, leaving the generated file on disk
   * after reporting a successful undo. It has to remove the file — with the same
   * staged-edit protection a `create` gets.
   */
  it('removes a file the migration created through an edit entry', () => {
    const root = makeProject({
      'package.json': `${JSON.stringify({ name: 'r', version: '1.0.0' }, null, 2)}\n`,
      'vitest.config.ts': 'export default { test: { testTimeout: 10000, hookTimeout: 10000 } };\n',
      '.npmrc': 'registry=https://example.test\nstrict-ssl=false\n',
    });
    try {
      expect(run('apply', '--root', root, '--allow-dirty').code).toBe(0);
      expect(existsSync(join(root, 'bun-migrate.timeout.ts'))).toBe(true);
      expect(existsSync(join(root, 'bunfig.toml'))).toBe(true);
      const journal = newestJournal(root, '.json');
      expect(run('revert', '--root', root, journal).code).toBe(0);
      expect(existsSync(join(root, 'bun-migrate.timeout.ts'))).toBe(false);
      expect(existsSync(join(root, 'bunfig.toml'))).toBe(false);
      expect(existsSync(join(root, 'vitest.config.ts'))).toBe(true);
      expect(existsSync(join(root, '.npmrc'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a staged edit when removing a file the migration created through an edit entry', () => {
    const root = makeProject({
      'package.json': `${JSON.stringify({ name: 'r', version: '1.0.0' }, null, 2)}\n`,
      'vitest.config.ts': 'export default { test: { testTimeout: 10000, hookTimeout: 10000 } };\n',
    });
    try {
      const git = (...args) => Bun.spawnSync(['git', ...args], { cwd: root });
      git('init', '-q', '.');
      git('config', 'user.email', 'test@example.test');
      git('config', 'user.name', 'test');
      git('add', '-A');
      git('commit', '-qm', 'init');
      expect(run('apply', '--root', root, '--allow-dirty').code).toBe(0);
      writeFileSync(join(root, 'bun-migrate.timeout.ts'), '// user edited this\n', 'utf8');
      git('add', 'bun-migrate.timeout.ts');
      const journal = newestJournal(root, '.json');
      const revert = run('revert', '--root', root, journal);
      expect(revert.code).toBe(0);
      expect(git('show', ':bun-migrate.timeout.ts').stdout.toString()).toContain('user edited');
      git('checkout', '--', 'bun-migrate.timeout.ts');
      expect(readFileSync(join(root, 'bun-migrate.timeout.ts'), 'utf8')).toContain('user edited');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('brings back every removed file in one run', () => {
    const root = makeProject(LEGACY);
    try {
      const originals = new Map();
      for (const path of [
        '.npmrc',
        '.nvmrc',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'vitest.config.ts',
      ]) {
        originals.set(path, readFileSync(join(root, path), 'utf8'));
      }
      expect(run('apply', '--root', root, '--allow-dirty').code).toBe(0);
      for (const path of originals.keys()) {
        expect(`${path} removed=${!existsSync(join(root, path))}`).toBe(`${path} removed=true`);
      }
      const journal = newestJournal(root, '.json');
      expect(run('revert', '--root', root, journal).code).toBe(0);
      for (const [path, content] of originals) {
        expect(`${path} restored=${existsSync(join(root, path))}`).toBe(`${path} restored=true`);
        expect(readFileSync(join(root, path), 'utf8')).toBe(content);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records the removed content in the journal', () => {
    const root = makeProject(LEGACY);
    try {
      expect(run('apply', '--root', root, '--allow-dirty').code).toBe(0);
      const journal = newestJournal(root, '.json');
      const payload = JSON.parse(readFileSync(journal, 'utf8'));
      const removed = payload.changes.filter((item) => item.kind === 'remove');
      expect(removed.length).toBeGreaterThan(0);
      for (const item of removed) {
        expect(typeof item.before).toBe('string');
        expect(item.before.length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('warns instead of pretending when a removal has no recorded content', () => {
    const root = makeProject({ 'package.json': '{"name":"r","version":"1.0.0"}\n' });
    try {
      mkdirSync(join(root, '.bun-migrate'), { recursive: true });
      const journalPath = join(root, '.bun-migrate', 'journal-manual.json');
      writeFileSync(
        journalPath,
        JSON.stringify({
          changes: [{ kind: 'remove', layer: 'config', file: 'gone.txt', detail: 'test' }],
          removed: ['gone.txt'],
        }),
        'utf8',
      );
      const revert = run('revert', '--root', root, journalPath);
      expect(revert.code).toBe(0);
      expect(revert.out).toContain('its content was not recorded');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Removal must not destroy work that `revert` cannot bring back.
 *
 * The deleted file's own bytes are recorded in the journal, so restoring *that* was
 * never the problem. The problem was the index: `git rm --force` deletes the staged
 * blob along with the worktree copy, and a staged edit that was never committed has
 * no other copy. Measured before the fix — `git show :pnpm-lock.yaml` after the
 * removal reported "neither on disk nor in the index", leaving the content reachable
 * only as an unreachable blob no command points at. These cases pin the safe
 * behaviour for the three git states a project can be in.
 */
describe('removal leaves a recoverable git state', () => {
  function makeRepo() {
    const root = mkdtempSync(join(tmpdir(), 'revert-git-'));
    const git = (...args) => Bun.spawnSync(['git', ...args], { cwd: root });
    git('init', '-q', '.');
    git('config', 'user.email', 'test@example.test');
    git('config', 'user.name', 'test');
    writeFileSync(join(root, 'package.json'), '{"name":"g","version":"1.0.0"}\n', 'utf8');
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 5.4\n# COMMITTED\n', 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'init');
    return { root, git };
  }

  it('stages the deletion of a clean tracked file', () => {
    const { root, git } = makeRepo();
    try {
      expect(run('apply', '--root', root, '--allow-dirty', '--only', 'packages').code).toBe(0);
      expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(false);
      expect(git('status', '--porcelain').stdout.toString()).toContain('D  pnpm-lock.yaml');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a staged edit in the index instead of discarding it', () => {
    const { root, git } = makeRepo();
    try {
      writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 5.4\n# STAGED EDIT\n', 'utf8');
      git('add', 'pnpm-lock.yaml');
      expect(run('apply', '--root', root, '--allow-dirty', '--only', 'packages').code).toBe(0);
      expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(false);
      expect(git('show', ':pnpm-lock.yaml').stdout.toString()).toContain('STAGED EDIT');
      git('checkout', '--', 'pnpm-lock.yaml');
      expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toContain('STAGED EDIT');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores an uncommitted edit through revert', () => {
    const { root } = makeRepo();
    try {
      writeFileSync(
        join(root, 'pnpm-lock.yaml'),
        'lockfileVersion: 5.4\n# NEVER COMMITTED\n',
        'utf8',
      );
      expect(run('apply', '--root', root, '--allow-dirty', '--only', 'packages').code).toBe(0);
      const journal = newestJournal(root, '.json');
      expect(run('revert', '--root', root, journal).code).toBe(0);
      expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toContain('NEVER COMMITTED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes an untracked file without git complaining', () => {
    const { root, git } = makeRepo();
    try {
      git('rm', '--quiet', '--cached', '--', 'pnpm-lock.yaml');
      git('commit', '-qm', 'untrack');
      writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 5.4\n# UNTRACKED\n', 'utf8');
      expect(run('apply', '--root', root, '--allow-dirty', '--only', 'packages').code).toBe(0);
      expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never passes --force to git rm', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'journal.mjs'), 'utf8');
    expect(/\brm'[^\]]*'--force'/.test(source)).toBe(false);
    expect(source.includes("'git', 'rm'")).toBe(true);
  });

  /**
   * The guard above only read `journal.mjs`, so it passed while `cli.mjs` still ran
   * `git rm --force` on the `revert` path. Measured after that fix shipped: undoing a
   * created file that the user had staged wiped the index entry and `git show :path`
   * said "neither on disk nor in the index". The check now covers every source file,
   * which is the property that was actually meant.
   */
  it('never passes --force to git rm anywhere in the source', () => {
    const directory = join(import.meta.dir, '..', 'src');
    const offenders = [];
    const walk = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.mjs')) continue;
        const text = readFileSync(full, 'utf8');
        if (/'git',\s*'rm'[^\]]*'--force'/.test(text)) offenders.push(entry.name);
      }
    };
    walk(directory);
    expect(JSON.stringify(offenders)).toBe('[]');
  });

  it('revert un-stages the deletion it staged for a clean tracked file', () => {
    const { root, git } = makeRepo();
    try {
      expect(run('apply', '--root', root, '--allow-dirty', '--only', 'packages').code).toBe(0);
      const journal = newestJournal(root, '.json');
      expect(run('revert', '--root', root, journal).code).toBe(0);
      expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toContain('COMMITTED');
      expect(git('status', '--porcelain').stdout.toString()).not.toContain('pnpm-lock.yaml');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('revert keeps a staged edit to a file the migration created', () => {
    const { root, git } = makeRepo();
    try {
      writeFileSync(join(root, 'bunfig.toml'), '[install]\nregistry = "https://example.test"\n');
      git('add', 'bunfig.toml');
      mkdirSync(join(root, '.bun-migrate'), { recursive: true });
      const journalPath = join(root, '.bun-migrate', 'journal-created.json');
      writeFileSync(
        journalPath,
        JSON.stringify({
          changes: [{ kind: 'create', layer: 'config', file: 'bunfig.toml', detail: 'created' }],
        }),
        'utf8',
      );
      const revert = run('revert', '--root', root, journalPath);
      expect(revert.code).toBe(0);
      expect(revert.out).toContain('index entry kept');
      expect(git('show', ':bunfig.toml').stdout.toString()).toContain('registry');
      git('checkout', '--', 'bunfig.toml');
      expect(readFileSync(join(root, 'bunfig.toml'), 'utf8')).toContain('registry');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a journal entry that escapes the project root', () => {
    const { root } = makeRepo();
    try {
      mkdirSync(join(root, '.bun-migrate'), { recursive: true });
      const journalPath = join(root, '.bun-migrate', 'journal-escape.json');
      writeFileSync(
        journalPath,
        JSON.stringify({
          changes: [
            {
              kind: 'edit',
              layer: 'config',
              file: '../escape-bun-migrate.txt',
              before: 'outside',
              after: 'x',
            },
          ],
        }),
        'utf8',
      );
      const revert = run('revert', '--root', root, journalPath);
      expect(revert.code).toBe(0);
      expect(revert.err).toContain('outside the project root');
      expect(existsSync(join(root, '..', 'escape-bun-migrate.txt'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
