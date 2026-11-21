import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const OUT = path.join(import.meta.dirname, 'g1');
const SHAS = [
  '453ba6bb1d', 'f407c52e39', '401b4a015f', 'f082f04a09', '7052fbbefd',
  '8d939f7dc7', '334d79870e', '1ccbe4127d', 'd729f91529', '391d9e7f4a',
  '6e35efa984', 'ca14f88807', '4d38c0080f', 'ff61a26074', 'a5e355e271',
  '2eb3e87c66', '374466c66c', '71db6b7d38', 'a4332bec13', '6819b036cd',
];
function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}
for (const prefix of SHAS) {
  const sha = git(['rev-parse', prefix]).trim();
  const parents = git(['rev-list', '--parents', '-n', '1', sha]).trim().split(/\r?\n/)[0].split(' ');
  const isMerge = parents.length > 2;
  const base = isMerge ? parents[1] : `${sha}~1`;
  const diffArgs = isMerge ? ['diff', '--no-renames', base, sha] : ['show', '--no-renames', '--format=fuller', sha];
  const statArgs = isMerge ? ['diff', '--stat', '--no-renames', base, sha] : ['show', '--stat', '--oneline', '--format=fuller', sha];
  const diff = git(diffArgs);
  const stat = git(statArgs);
  const names = git(['diff', '--name-status', '--no-renames', base, sha]);
  fs.writeFileSync(path.join(OUT, `${prefix}.diff`), diff);
  fs.writeFileSync(path.join(OUT, `${prefix}.stat`), stat);
  fs.writeFileSync(path.join(OUT, `${prefix}.paths`), names);
  const files = names.trim().split(/\r?\n/).filter(Boolean).length;
  console.log(`${prefix}\tmerge=${isMerge}\tfiles=${files}\tdiff_lines=${diff.split(/\r?\n/).length}`);
}
