import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const OUT = path.join(import.meta.dirname, 'g2');
const SHAS = ['d64909f972','68b849c90d','1364ab4741','1fc7be4001','638c6ffe03','29bc56daaf','6130601871','88e3c20739','b37c9bb857','cab0c0e5ad','50ec3c3940','e5ae24239b','8d7948e111','e122269955','5ae973905c','285584e188'];
function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}
for (const prefix of SHAS) {
  const sha = git(['rev-parse', prefix]).trim();
  const diff = git(['show', '--no-renames', '--format=fuller', sha]);
  const names = git(['diff-tree', '-r', '--no-commit-id', '--name-status', '--no-renames', sha]);
  fs.writeFileSync(path.join(OUT, `${prefix}.diff`), diff);
  fs.writeFileSync(path.join(OUT, `${prefix}.paths`), names);
  console.log(`${prefix}\tfiles=${names.trim().split(/\r?\n/).filter(Boolean).length}\tlines=${diff.split(/\r?\n/).length}`);
}
