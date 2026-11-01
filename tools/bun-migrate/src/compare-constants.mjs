/**
 * Compare constant values, not just their names.
 *
 * A name present on both sides with a different value is the worst kind of
 * difference: the code compiles, the call succeeds, and the branch goes the wrong
 * way. Nothing in a log says so. This compares scalars by value and reports the
 * rest by kind.
 */
import { readFileSync } from 'node:fs';

const node = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const bun = JSON.parse(readFileSync(process.argv[3], 'utf8'));

const valueDiffers = [];
const kindDiffers = [];
const missing = [];
const extra = [];

for (const [path, nodeEntry] of Object.entries(node.values)) {
  const bunEntry = bun.values[path];
  if (!bunEntry || bunEntry.load !== 'ok') {
    if (nodeEntry.load === 'ok') missing.push({ path, key: '(whole object)', note: bunEntry?.load ?? 'absent' });
    continue;
  }
  if (nodeEntry.load !== 'ok') continue;

  for (const [key, nodeItem] of Object.entries(nodeEntry.entries)) {
    const bunItem = bunEntry.entries[key];
    if (!bunItem) {
      missing.push({ path, key, nodeValue: nodeItem.value });
      continue;
    }
    if (nodeItem.kind !== bunItem.kind) {
      kindDiffers.push({ path, key, nodeKind: nodeItem.kind, bunKind: bunItem.kind });
      continue;
    }
    if (nodeItem.kind !== 'scalar') continue;
    if (nodeItem.value !== bunItem.value) {
      valueDiffers.push({ path, key, nodeValue: nodeItem.value, bunValue: bunItem.value });
    }
  }
  for (const [key, bunItem] of Object.entries(bunEntry.entries)) {
    if (!(key in nodeEntry.entries)) extra.push({ path, key, bunValue: bunItem.value });
  }
}

const lines = [
  `# constant values: ${node.engine} ${node.version} vs ${bun.engine} ${bun.version}`,
  '',
  `## value differs (${valueDiffers.length})`,
];
for (const item of valueDiffers) {
  lines.push(`  ${item.path.replace('#', ' ')}.${item.key}: node ${JSON.stringify(item.nodeValue)} vs bun ${JSON.stringify(item.bunValue)}`);
}

lines.push('');
lines.push(`## kind differs (${kindDiffers.length})`);
for (const item of kindDiffers) {
  lines.push(`  ${item.path.replace('#', ' ')}.${item.key}: node ${item.nodeKind} vs bun ${item.bunKind}`);
}

lines.push('');
lines.push(`## missing (${missing.length})`);
for (const item of missing) {
  lines.push(`  ${item.path.replace('#', ' ')}.${item.key}${item.note ? ` (${item.note})` : ''}`);
}

lines.push('');
lines.push(`## extra (${extra.length})`);
for (const item of extra) {
  lines.push(`  ${item.path.replace('#', ' ')}.${item.key}`);
}

process.stdout.write(`${lines.join('\n')}\n`);
