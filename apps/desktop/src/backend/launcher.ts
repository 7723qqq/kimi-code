import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DESKTOP_PLUGIN_ENTRY = '__desktop_plugin_entry';

if (process.argv[2] === DESKTOP_PLUGIN_ENTRY) {
  const root = process.env['KIMI_PLUGIN_ROOT'];
  const entry = process.argv[3];
  if (root === undefined || root.trim() === '' || entry === undefined)
    throw new Error('Desktop plugin entry requires KIMI_PLUGIN_ROOT and an entry');
  const [rootReal, entryReal] = await Promise.all([realpath(root), realpath(entry)]);
  const inside = relative(rootReal, entryReal);
  if (inside.startsWith('..') || isAbsolute(inside))
    throw new Error('Desktop plugin entry must be inside its plugin root');
  process.argv = [process.execPath, entryReal, ...process.argv.slice(4)];
  await import(pathToFileURL(entryReal).href);
} else {
  await import('./entry');
}
