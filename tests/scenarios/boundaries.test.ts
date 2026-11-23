import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { expect, it } from 'bun:test';

const ROOT = import.meta.dirname;
const ALLOWED = [/^bun:test$/, /^node:/, /^@moonshot-ai\/testkit\/(model|kap|fixtures|bun)$/, /^@moonshot-ai\/kap-server$/, /^\.\/support\/[\w-]+$/];

it('drives the product only through the KAP server entry and the testkit', async () => {
  const offending: string[] = [];
  for (const file of await sourceFiles(ROOT)) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1] ?? '';
      if (!ALLOWED.some((pattern) => pattern.test(specifier))) offending.push(`${relative(ROOT, file)} imports ${specifier}`);
    }
  }
  expect(offending).toEqual([]);
});

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}
