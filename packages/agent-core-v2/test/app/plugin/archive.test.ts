import { readFile, stat } from 'node:fs/promises';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadZip, extractZip } from '#/app/plugin/archive';

import { createZipFromDir } from './zip-helper';

describe('plugin archive extraction', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-archive-test-'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it('extracts a zip and detects a nested plugin root', async () => {
    const source = join(dir, 'source');
    const nested = join(source, 'plugin');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'kimi.plugin.json'), JSON.stringify({ name: 'zip-demo' }), 'utf8');
    const zip = await createZipFromDir(source);

    const outDir = join(dir, 'out');
    const detectedRoot = await extractZip(zip, outDir);

    expect(detectedRoot).toBe(join(outDir, 'plugin'));
    await expect(readFile(join(detectedRoot, 'kimi.plugin.json'), 'utf8')).resolves.toContain(
      'zip-demo',
    );
  });

  it('refuses zip downloads advertised above the cap via content-length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('x', {
            status: 200,
            headers: { 'content-length': String(256 * 1024 * 1024 + 1) },
          }),
      ),
    );

    await expect(downloadZip('https://example.com/plugin.zip')).rejects.toThrow(
      'Zip download too large',
    );
  });

  it('aborts extraction when a single entry exceeds the size cap and cleans up', async () => {
    const source = join(dir, 'source');
    const nested = join(source, 'plugin');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'kimi.plugin.json'), JSON.stringify({ name: 'big-demo' }), 'utf8');
    await writeFile(join(nested, 'huge.bin'), Buffer.alloc(65 * 1024 * 1024, 1), 'utf8');
    const zip = await createZipFromDir(source);
    const outDir = join(dir, 'out');

    await expect(extractZip(zip, outDir)).rejects.toThrow(/single-file limit/);
    await expect(stat(outDir)).rejects.toThrow();
  });
});
