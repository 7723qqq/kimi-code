import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const AUDIT = path.resolve(import.meta.dirname);
const RANGE = [
  'b0de2fbd2de04d87689225aafd3912e5d193b62d',
  'a5e355e2718a2ebf70d8229fa5a05fe35d5f98a1',
];
const EXTRA = ['b263e80ff3ca93998336b1f89e7bc85946f8f76f', '392505cf579dcb2cfa92de1ca0262bb2407ace30'];
const TAGS = [
  'package.json',
  'bun.lock',
  'bunfig.toml',
  'flake.nix',
  'tsconfig.json',
  '.gitattributes',
  'AGENTS.md',
  'DEVELOP.md',
  'CONVENTIONS.md',
  'CONTRIBUTING.md',
];

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

const GROUPS = {
  G1: '453ba6bb1d f407c52e39 401b4a015f f082f04a09 7052fbbefd 8d939f7dc7 334d79870e 1ccbe4127d d729f91529 391d9e7f4a 6e35efa984 ca14f88807 4d38c0080f ff61a26074 a5e355e271 2eb3e87c66 374466c66c 71db6b7d38 a4332bec13 6819b036cd',
  G2: 'd64909f972 68b849c90d 1364ab4741 1fc7be4001 638c6ffe03 29bc56daaf 6130601871 88e3c20739 b37c9bb857 cab0c0e5ad 50ec3c3940 e5ae24239b 8d7948e111 e122269955 5ae973905c 285584e188',
  G3: '1ec24a5f51 410814349d 482936afce 1c1544abaf 0ea324cafb 90d3a66c64 a09bf8573c 7e2c565e31',
  G4: 'f538d534cc fec742878d 2f33641b73 13d363e180 b957457968 a692ff9af2 2931c7efd5 de1fdaa89d baa7b4bcfc 84439d5f4e 3a05a7ec93 22d559b089 7057fa3437 44bcf37e2b 0b73b629de',
  G5: '5db75e0c20 8d426de887 5be33daf1d 63b94bc4c0 08997afe2b',
  G6: 'aced52f218 135993745d 182b324c24 1935082ce7 a656ab627a',
  G7: 'd1fe15f7f8 4567ffcf5d f48ae9151a',
};

const rangeCommits = git(['rev-list', '--reverse', `${RANGE[0]}..${RANGE[1]}`])
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
const allCommits = [...rangeCommits, ...EXTRA];

const groupOfCommit = new Map();
for (const [group, shas] of Object.entries(GROUPS)) {
  for (const prefix of shas.split(' ')) {
    const commit = allCommits.find((sha) => sha.startsWith(prefix));
    if (commit) groupOfCommit.set(commit, group);
  }
}

const pathGroup = new Map();
const union = new Set();
for (const commit of allCommits) {
  const parents = git(['rev-list', '--parents', '-n', '1', commit]).trim().split(/\r?\n/)[0].split(' ');
  const isMerge = parents.length > 2;
  const args = isMerge
    ? ['diff', '--name-only', '--no-renames', parents[1], commit]
    : ['diff-tree', '-r', '--no-commit-id', '--name-only', '--no-renames', commit];
  const paths = git(args).trim().split(/\r?\n/).filter(Boolean);
  const group = groupOfCommit.get(commit) ?? 'G6';
  for (const p of paths) {
    union.add(p);
    if (!pathGroup.has(p)) pathGroup.set(p, group);
  }
}
for (const tag of TAGS) {
  union.add(tag);
  if (!pathGroup.has(tag)) pathGroup.set(tag, 'meta');
}

const upstreamTree = new Map();
for (const line of git(['ls-tree', '-r', '-l', RANGE[1]]).trim().split(/\r?\n/)) {
  if (!line) continue;
  const tab = line.indexOf('\t');
  const meta = line.slice(0, tab).split(/\s+/);
  const p = line.slice(tab + 1);
  upstreamTree.set(p, { sha: meta[2], size: Number(meta[3]) });
}

const statusRaw = git(['status', '--porcelain=v1', '-z', '-uall']);
const tokens = statusRaw.split('\0');
const entries = [];
for (let i = 0; i < tokens.length; i++) {
  const token = tokens[i];
  if (!token) continue;
  const status = token.slice(0, 2);
  const p = token.slice(3);
  let oldPath;
  if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') {
    oldPath = tokens[++i];
  }
  entries.push({ status, path: p, oldPath });
}

const existing = entries.filter((entry) => fs.existsSync(path.join(ROOT, entry.path)));
const hashInput = existing.map((entry) => entry.path).join('\n') + '\n';
const hashed = existing.length
  ? git(['hash-object', '--stdin-paths'], { input: hashInput }).trim().split(/\r?\n/)
  : [];
const localHash = new Map();
existing.forEach((entry, index) => localHash.set(entry.path, hashed[index]));

const GENERATED = [
  'apps/kimi-code/dist-web/',
  'apps/kimi-code/dist/',
  'apps/desktop/test-results/',
  'apps/desktop/dist/',
  'apps/desktop/out/',
  'node_modules/',
  '.tmp/',
  'graphify-out/',
  '.local/',
];
const LEDGER = [
  '.upstream/',
  'specs/mantis-scarlet-witch-green-arrow/',
  'specs/upstream-sync-ledger/',
  'scripts/upstream-ledger.mjs',
  'scripts/test/upstream-ledger',
];
const PORT_ROOTS = [
  'packages/core/',
  'apps/desktop/',
  'packages/app-client/',
  'packages/app-components/',
  'packages/app-composer/',
  'packages/app-core/',
  'packages/app-i18n/',
  'packages/app-markdown/',
  'packages/app-ui/',
  'packages/testkit/',
  'KIMI CODE LOGO/',
  'scripts/icon-tools/',
];

function classify(entry) {
  const p = entry.path.replaceAll('\\', '/');
  const status = entry.status;
  const inUnion = union.has(p);
  const upstream = upstreamTree.get(p);
  const local = localHash.get(p);
  const group = pathGroup.get(p) ?? '';

  if (LEDGER.some((prefix) => p.startsWith(prefix))) return ['ledger-spec', group || 'ledger-spec'];
  if (GENERATED.some((prefix) => p.startsWith(prefix))) return ['generated', group || 'generated'];
  if (status.trim() === 'D') {
    if (!upstream) return ['port-upstream', group || 'meta'];
    return [inUnion ? 'port-adaptation' : 'preexisting-unrelated', group || 'meta'];
  }
  if (upstream) {
    if (local === upstream.sha) return ['port-upstream', group || 'meta'];
    if (inUnion) return ['port-adaptation', group || 'meta'];
    if (PORT_ROOTS.some((prefix) => p.startsWith(prefix))) return ['port-adaptation', group || 'meta'];
    return ['preexisting-unrelated', group || 'meta'];
  }
  if (inUnion) {
    return ['port-adaptation', group || 'meta'];
  }
  if (PORT_ROOTS.some((prefix) => p.startsWith(prefix))) return ['port-adaptation', group || 'meta'];
  if (TAGS.includes(p)) return ['port-metadata', 'meta'];
  return ['preexisting-unrelated', 'none'];
}

const rows = entries.map((entry) => {
  const [cls, batch] = classify(entry);
  return `${entry.path}\t${entry.status}\t${cls}\t${batch}\t${entry.oldPath ?? ''}`;
});
rows.sort();
fs.writeFileSync(path.join(AUDIT, 'worktree.tsv'), `path\tstatus\tclass\tbatch\told_path\n${rows.join('\n')}\n`);

const counts = new Map();
for (const row of rows) {
  const cls = row.split('\t')[2];
  counts.set(cls, (counts.get(cls) ?? 0) + 1);
}
console.log(`status entries: ${entries.length}`);
console.log(`range commits: ${rangeCommits.length}; union paths: ${union.size}; upstream paths: ${upstreamTree.size}`);
console.log([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}\t${v}`).join('\n'));
