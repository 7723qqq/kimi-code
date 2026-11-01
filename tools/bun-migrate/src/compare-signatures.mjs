/**
 * Compare function signatures across runtimes.
 *
 * `lengthDiffers` is the category that matters most: a caller branching on
 * `fn.length` takes a different path, and nothing throws. `nameDiffers` is
 * reported separately because it is mostly noise from anonymous functions and
 * should not drown the real finding.
 */
import { readFileSync } from 'node:fs';

const node = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const bun = JSON.parse(readFileSync(process.argv[3], 'utf8'));

const lengthDiffers = [];
const nameDiffers = [];
const missing = [];
const extra = [];

function compareCollection(path, nodeFns, bunFns) {
  for (const [member, nodeSig] of Object.entries(nodeFns ?? {})) {
    const bunSig = bunFns?.[member];
    if (!bunSig) {
      missing.push({ path, member });
      continue;
    }
    if (nodeSig.length !== bunSig.length) {
      lengthDiffers.push({ path, member, nodeLength: nodeSig.length, bunLength: bunSig.length });
    }
    if (nodeSig.name !== bunSig.name) {
      nameDiffers.push({ path, member, nodeName: nodeSig.name, bunName: bunSig.name });
    }
  }
  for (const member of Object.keys(bunFns ?? {})) {
    if (!(member in (nodeFns ?? {}))) extra.push({ path, member });
  }
}

for (const [moduleName, nodeEntry] of Object.entries(node.modules)) {
  const bunEntry = bun.modules[moduleName];
  if (!bunEntry || nodeEntry.load !== 'ok' || bunEntry.load !== 'ok') continue;
  compareCollection(moduleName, nodeEntry.functions, bunEntry.functions);
  for (const [parent, inner] of Object.entries(nodeEntry.nested ?? {})) {
    compareCollection(`${moduleName}#${parent}`, inner, bunEntry.nested?.[parent]);
  }
}

const lines = [
  `# signatures: ${node.engine} ${node.version} vs ${bun.engine} ${bun.version}`,
  '',
  `## length differs (${lengthDiffers.length})`,
];
for (const item of lengthDiffers) {
  lines.push(`  ${item.path}#${item.member}: node ${item.nodeLength} params vs bun ${item.bunLength}`);
}

lines.push('');
lines.push(`## name differs (${nameDiffers.length})`);
for (const item of nameDiffers) {
  lines.push(`  ${item.path}#${item.member}: node "${item.nodeName}" vs bun "${item.bunName}"`);
}

lines.push('');
lines.push(`## missing (${missing.length})`);
for (const item of missing) lines.push(`  ${item.path}#${item.member}`);

lines.push('');
lines.push(`## extra (${extra.length})`);
for (const item of extra) lines.push(`  ${item.path}#${item.member}`);

process.stdout.write(`${lines.join('\n')}\n`);
