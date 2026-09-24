/**
 * Scenario: the project-local config (`.kimi-code/local.toml`) read and write
 * surface. Responsibilities: locate the project root, resolve and validate
 * `workspace.additional_dir`, and append to the file without disturbing the
 * sections it does not model.
 * Wiring: the real module over a real temp checkout; the engine and the host
 * are never started.
 * Run: cd packages/node-sdk && bunx vitest run test/project-local-config.test.ts
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { KimiError } from '#/index';
import {
  appendAdditionalDir,
  locateAdditionalDirsConfig,
  readAdditionalDirs,
  resolveAdditionalDirs,
} from '#/project-local-config';

const tempDirs: string[] = [];

// The module reports forward-slashed paths on every platform (v2 resolved with
// pathe); mirror that in path assertions so they hold on Windows.
const toPosix = (p: string): string => p.replaceAll('\\', '/');

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A temp checkout: `<root>/.git` marks the project root. */
async function makeProject(): Promise<{ root: string; workDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'kimi-sdk-local-toml-'));
  tempDirs.push(base);
  const root = join(base, 'project');
  const workDir = join(root, 'packages', 'app');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(workDir, { recursive: true });
  return { root, workDir };
}

async function writeLocalToml(root: string, body: string): Promise<void> {
  await mkdir(join(root, '.kimi-code'), { recursive: true });
  await writeFile(join(root, '.kimi-code', 'local.toml'), body, 'utf-8');
}

describe('project-local config', () => {
  it('finds the project root by walking up to .git', async () => {
    const { root, workDir } = await makeProject();
    const located = await locateAdditionalDirsConfig(workDir);
    expect(located.projectRoot).toBe(toPosix(root));
    expect(located.configPath).toBe(toPosix(join(root, '.kimi-code', 'local.toml')));
  });

  it('falls back to the working directory when no .git is above it', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kimi-sdk-no-git-'));
    tempDirs.push(base);
    const located = await locateAdditionalDirsConfig(base);
    expect(located.projectRoot).toBe(toPosix(base));
  });

  it('reads entries, resolving relative ones against the project root', async () => {
    const { root, workDir } = await makeProject();
    const shared = join(root, 'shared');
    await mkdir(shared);
    await mkdir(join(root, 'nested'));
    await writeLocalToml(
      root,
      [
        '[workspace]',
        `additional_dir = ["shared", ${JSON.stringify(join(root, 'nested'))}]`,
        '',
      ].join('\n'),
    );

    const loaded = await readAdditionalDirs(workDir);
    expect(loaded.additionalDirs).toEqual([toPosix(shared), toPosix(join(root, 'nested'))]);
  });

  it('returns no roots when the file or the table is absent', async () => {
    const { workDir } = await makeProject();
    expect((await readAdditionalDirs(workDir)).additionalDirs).toEqual([]);
    const { root } = await makeProject();
    await writeLocalToml(root, '[tools]\nverbose = true\n');
    expect((await readAdditionalDirs(workDir)).additionalDirs).toEqual([]);
  });

  it('deduplicates entries that name the same directory', async () => {
    const { root, workDir } = await makeProject();
    const shared = join(root, 'shared');
    await mkdir(shared);
    await writeLocalToml(
      root,
      `[workspace]\nadditional_dir = [${JSON.stringify(shared)}, ${JSON.stringify(shared)}]\n`,
    );
    expect((await readAdditionalDirs(workDir)).additionalDirs).toEqual([toPosix(shared)]);
  });

  it('normalizes an entry before resolving it', async () => {
    const { root, workDir } = await makeProject();
    const shared = join(root, 'shared');
    await mkdir(shared);
    // Padded and carrying a `..` segment: both are collapsed before the entry
    // is resolved, so it lands on the same directory.
    const padded = toPosix(shared).replace(/\/shared$/, '/nested/../shared');
    await writeLocalToml(
      root,
      `[workspace]\nadditional_dir = [${JSON.stringify(` ${padded} `)}]\n`,
    );
    expect((await readAdditionalDirs(workDir)).additionalDirs).toEqual([toPosix(shared)]);
  });

  // Upstream #4013 rolled back #3964's `isBroadScopeDir` rejection: a root that
  // used to be refused for handing the agent the whole disk or the whole home
  // directory resolves like any other directory again.
  it('accepts the home directory and the filesystem root', async () => {
    const { root } = await makeProject();
    const rootOfDrive = parse(root).root;
    expect(await resolveAdditionalDirs(root, [homedir()])).toHaveLength(1);
    expect(await resolveAdditionalDirs(root, [rootOfDrive])).toHaveLength(1);
  });

  it('refuses an entry that is missing or not a directory', async () => {
    const { root } = await makeProject();
    const file = join(root, 'notes.txt');
    await writeFile(file, 'x', 'utf-8');
    await expect(resolveAdditionalDirs(root, [join(root, 'absent')])).rejects.toThrow(
      /must exist and be a directory/,
    );
    await expect(resolveAdditionalDirs(root, [file])).rejects.toThrow(
      /must exist and be a directory/,
    );
  });

  it('reports invalid TOML and a non-string list as config errors', async () => {
    const { root, workDir } = await makeProject();
    await writeLocalToml(root, '[workspace\n');
    await expect(readAdditionalDirs(workDir)).rejects.toThrow(/Invalid TOML/);

    await writeLocalToml(root, '[workspace]\nadditional_dir = [1, 2]\n');
    await expect(readAdditionalDirs(workDir)).rejects.toThrow(/must be an array of strings/);

    await writeLocalToml(root, '[workspace]\nadditional_dir = "shared"\n');
    await expect(readAdditionalDirs(workDir)).rejects.toThrow(KimiError);
  });

  it('appends a directory, creating the file and keeping other sections', async () => {
    const { root, workDir } = await makeProject();
    await writeLocalToml(root, '[tools]\nverbose = true\n');
    const shared = join(root, 'shared');
    await mkdir(shared);

    const first = await appendAdditionalDir(workDir, shared);
    expect(first.projectRoot).toBe(toPosix(root));
    expect(first.additionalDirs).toEqual([toPosix(shared)]);
    const text = await readFile(first.configPath, 'utf-8');
    expect(text).toContain('verbose = true');
    expect(text).toContain(JSON.stringify(shared).slice(1, -1));

    // Appending the same directory again is a no-op, and a second one lands
    // beside it.
    const again = await appendAdditionalDir(workDir, shared);
    expect(again.additionalDirs).toEqual([toPosix(shared)]);
    const other = join(root, 'other');
    await mkdir(other);
    expect((await appendAdditionalDir(workDir, other)).additionalDirs).toEqual([
      toPosix(shared),
      toPosix(other),
    ]);
  });

  it('writes the resolved path, so a later read agrees with the write', async () => {
    const { workDir } = await makeProject();
    // A relative argument resolves against the working directory (v2
    // `appendAdditionalDir`), not against the project root.
    await mkdir(join(workDir, 'shared'));
    const written = await appendAdditionalDir(workDir, './shared');
    expect(written.additionalDirs).toEqual([toPosix(join(workDir, 'shared'))]);
    expect((await readAdditionalDirs(workDir)).additionalDirs).toEqual([
      toPosix(join(workDir, 'shared')),
    ]);
  });

  it('keeps both entries when two appends race', async () => {
    // Read-modify-write on one file: without serialization both callers read the
    // same empty document and the later write drops the earlier directory.
    const { root, workDir } = await makeProject();
    const first = join(root, 'first');
    const second = join(root, 'second');
    await mkdir(first);
    await mkdir(second);

    const expected = [toPosix(first), toPosix(second)].sort();
    await Promise.all([appendAdditionalDir(workDir, first), appendAdditionalDir(workDir, second)]);
    // The first caller legitimately reports only its own directory (its write
    // happened before the second one); the file must end up with both.
    expect([...(await readAdditionalDirs(workDir)).additionalDirs].sort()).toEqual(expected);
  });

  it('remembers a directory that used to be broad-scope and refuses a missing one', async () => {
    const { workDir } = await makeProject();
    // #4013 dropped the home-directory / filesystem-root rejection, so the write
    // face accepts them too.
    expect((await appendAdditionalDir(workDir, homedir())).additionalDirs).toHaveLength(1);
    await expect(appendAdditionalDir(workDir, resolve(workDir, 'absent'))).rejects.toThrow(
      /must exist and be a directory/,
    );
  });
});
