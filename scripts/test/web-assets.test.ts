import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { syncWebDist } from '../../apps/kimi-code/scripts/sync-web-dist.mjs';

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kimi-web-sync-'));
  roots.push(root);
  const source = join(root, 'source');
  const target = join(root, 'target');
  await mkdir(join(source, 'assets'), { recursive: true });
  await mkdir(target);
  await writeFile(join(source, 'index.html'), '<script src="/assets/new.js"></script>');
  await writeFile(join(source, 'assets', 'new.js'), 'export const generation = "new";');
  await writeFile(join(target, 'index.html'), '<p>old</p>');
  await writeFile(join(target, 'old-generation.js'), 'old');
  return { root, source, target };
}

describe('Desktop Web asset sync', () => {
  it('replaces a complete generation without retaining old assets or scratch directories', async () => {
    const { root, source, target } = await fixture();
    let builds = 0;
    const count = await syncWebDist({ source, target, build: async () => { builds += 1; } });
    expect(builds).toBe(1);
    expect(count).toBe(3);
    expect((await readdir(target, { recursive: true })).toSorted()).toEqual(['assets', join('assets', 'new.js'), 'index.html'].toSorted());
    expect(await readFile(join(target, 'index.html'), 'utf8')).toContain('/assets/new.js');
    expect((await readdir(root)).toSorted()).toEqual(['source', 'target']);
  });

  it('keeps the previous bundle when the renderer build fails', async () => {
    const { source, target } = await fixture();
    const failed = await syncWebDist({ source, target, build: async () => { throw new Error('renderer failed'); } }).then(() => undefined, (error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toBe('renderer failed');
    expect(await readFile(join(target, 'index.html'), 'utf8')).toBe('<p>old</p>');
    expect(await readFile(join(target, 'old-generation.js'), 'utf8')).toBe('old');
  });

  it('refuses a bundle with missing referenced assets before moving the old generation', async () => {
    const { root, source, target } = await fixture();
    await rm(join(source, 'assets', 'new.js'));
    const failed = await syncWebDist({ source, target, build: async () => {} }).then(() => undefined, (error: unknown) => error);
    expect((failed as Error).message).toContain('Missing referenced web asset');
    expect(await readFile(join(target, 'index.html'), 'utf8')).toBe('<p>old</p>');
    expect((await readdir(root)).toSorted()).toEqual(['source', 'target']);
  });
});
