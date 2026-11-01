/**
 * Compare the two enumerations and report every difference.
 *
 * Three categories matter, and they need different treatment:
 *   - missing: Node has it, Bun does not  -> code that calls it breaks on Bun
 *   - extra:   Bun has it, Node does not  -> code using it cannot go back to Node
 *   - type:    both have it, but one is a function and the other is a value
 */
import { readFileSync } from 'node:fs';

const node = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const bun = JSON.parse(readFileSync(process.argv[3], 'utf8'));

/**
 * Every member comes from `JSON.parse`, so the linter reads these records as
 * `unknown`. A type name is always a string in the enumeration input — the writer
 * uses `typeof value` — but the type system cannot see that, so each template below
 * goes through `typeLabel`, which narrows and falls back to a readable form rather
 * than letting an object print as `[object Object]`.
 */
function typeLabel(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return 'unknown';
  return JSON.stringify(value);
}

const missing = [];
const extra = [];
const typeMismatch = [];
const moduleLoadGaps = [];
const nestedMissing = [];
const nestedExtra = [];

for (const [moduleName, nodeEntry] of Object.entries(node.modules)) {
  const bunEntry = bun.modules[moduleName];
  if (!bunEntry) {
    moduleLoadGaps.push({ module: moduleName, reason: 'Bun does not list this module' });
    continue;
  }
  if (nodeEntry.load !== 'ok' && bunEntry.load === 'ok') {
    extra.push({ module: moduleName, member: '(whole module)', note: 'Bun provides, Node does not' });
    continue;
  }
  if (nodeEntry.load === 'ok' && bunEntry.load !== 'ok') {
    moduleLoadGaps.push({ module: moduleName, reason: `Bun throws: ${bunEntry.load}` });
    continue;
  }
  if (nodeEntry.load !== 'ok' && bunEntry.load !== 'ok') continue;

  const nodeMembers = nodeEntry.members ?? {};
  const bunMembers = bunEntry.members ?? {};

  for (const [member, nodeType] of Object.entries(nodeMembers)) {
    if (!(member in bunMembers)) {
      missing.push({ module: moduleName, member, nodeType });
      continue;
    }
    const bunType = bunMembers[member];
    if (nodeType !== bunType) {
      typeMismatch.push({ module: moduleName, member, nodeType, bunType });
    }
  }
  for (const [member, bunType] of Object.entries(bunMembers)) {
    if (!(member in nodeMembers)) {
      extra.push({ module: moduleName, member, bunType });
    }
  }

  for (const [parent, nodeInner] of Object.entries(nodeEntry.nested ?? {})) {
    const bunInner = bunEntry.nested?.[parent];
    if (!bunInner) {
      nestedMissing.push({ module: moduleName, path: parent, member: '(whole object)' });
      continue;
    }
    for (const [key, nodeType] of Object.entries(nodeInner)) {
      if (!(key in bunInner)) {
        nestedMissing.push({ module: moduleName, path: parent, member: key, nodeType });
        continue;
      }
      if (bunInner[key] !== nodeType) {
        typeMismatch.push({
          module: moduleName,
          member: `${parent}.${key}`,
          nodeType,
          bunType: bunInner[key],
        });
      }
    }
    for (const key of Object.keys(bunInner)) {
      if (!(key in nodeInner)) {
        nestedExtra.push({ module: moduleName, path: parent, member: key, bunType: bunInner[key] });
      }
    }
  }
}

const lines = [
  `# ${node.engine} ${node.version}  vs  ${bun.engine} ${bun.version}`,
  '',
  `## module load gaps (${moduleLoadGaps.length})`,
];
for (const gap of moduleLoadGaps) lines.push(`  ${gap.module}: ${gap.reason}`);

lines.push('');
lines.push(`## missing in Bun (${missing.length})`);
for (const item of missing) lines.push(`  ${item.module}#${item.member}  (node: ${typeLabel(item.nodeType)})`);

lines.push('');
lines.push(`## missing nested members (${nestedMissing.length})`);
for (const item of nestedMissing) {
  lines.push(`  ${item.module}#${item.path}.${item.member}  (node: ${typeLabel(item.nodeType ?? 'object')})`);
}

lines.push('');
lines.push(`## type mismatch (${typeMismatch.length})`);
for (const item of typeMismatch) {
  lines.push(`  ${item.module}#${item.member}: node ${typeLabel(item.nodeType)} vs bun ${typeLabel(item.bunType)}`);
}

lines.push('');
lines.push(`## extra in Bun (${extra.length})`);
for (const item of extra) lines.push(`  ${item.module}#${item.member}  (bun: ${typeLabel(item.bunType ?? item.note)})`);

lines.push('');
lines.push(`## extra nested members in Bun (${nestedExtra.length})`);
for (const item of nestedExtra) {
  lines.push(`  ${item.module}#${item.path}.${item.member}  (bun: ${typeLabel(item.bunType)})`);
}

process.stdout.write(`${lines.join('\n')}\n`);
