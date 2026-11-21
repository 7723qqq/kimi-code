import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const rows = [
  ['453ba6bb1d', 2, 'adds 2.6.0 en+zh changelog', '2.6.0 sections present', 'ported', 'grep:## 2.6.0', 'changelog line 68 en / 55 zh'],
  ['f407c52e39', 261, 'release/2026-11-12 sync: changesets, changelog, versions + docs/source', 'fork runs no release; content tracked by originating rows', 'not-applicable', 'manual', 'path list + source docs read; NA signed'],
  ['401b4a015f', 2, 'adds 2.6.1 en+zh changelog', '2.6.1 sections present', 'ported', 'grep:## 2.6.1', 'changelog line 61 en'],
  ['f082f04a09', 2, 'adds 2.6.2 en+zh changelog', '2.6.2 sections present', 'ported', 'grep:## 2.6.2', 'changelog line 44 en'],
  ['7052fbbefd', 2, 'adds 2.6.3 en+zh changelog', '2.6.3 sections present', 'ported', 'grep:## 2.6.3', 'changelog line 19 en'],
  ['8d939f7dc7', 141, 'release/2026-11-13 sync: release output only', 'fork runs no release; no source target', 'not-applicable', 'manual', 'all paths changesets/changelog/package; NA signed'],
  ['334d79870e', 220, 'release/2026-11-13-2 squash: feedback, searchUrl/feedbackUrl, docs', 'engine feedback service and provider fields present', 'equivalent', 'grep:feedbackUrl', 'provider.ts:19; full source diff read'],
  ['1ccbe4127d', 91, '2.6.3 release squash: notifications, origins, settled, config recovery, WebBridge', 'all key behaviors present in agent-core-v2', 'equivalent', 'grep:async settled', 'loopService.ts:1377; full source diff read'],
  ['d729f91529', 140, 'web dist bundle sync', 'generated bundle not in source tree', 'not-applicable', 'manual', 'all paths under dist-web; NA signed'],
  ['391d9e7f4a', 139, 'web dist bundle sync', 'generated bundle not in source tree', 'not-applicable', 'manual', 'all paths under dist-web; NA signed'],
  ['6e35efa984', 139, 'web dist bundle sync', 'upstream 2.7.0 has no dist-web', 'not-applicable', 'manual', 'path list verified; NA signed'],
  ['ca14f88807', 139, 'web dist bundle sync', 'upstream 2.7.0 has no dist-web', 'not-applicable', 'manual', 'path list verified; NA signed'],
  ['4d38c0080f', 9, 'renames other-agents guide and nav', 'docs/guides/other-agents.md absent', 'not-applicable', 'manual', 'page and nav absent; NA signed'],
  ['ff61a26074', 15, 'restores remote env guidance and quote normalization', 'fork docs already fuller; --environment-cwd present', 'equivalent', 'grep:--environment-cwd', 'remote-environment.md:82'],
  ['a5e355e271', 66, '2.7.0 release commit: changesets, changelog, versions', 'fork does not bump versions', 'not-applicable', 'manual', 'path list only release output; NA signed'],
  ['2eb3e87c66', 5, 'canary/desktop/release titles', 'canary title ported; desktop/release targets absent', 'equivalent', 'grep:--title "Kimi Code CLI', 'canary-release.yml:158/162'],
  ['374466c66c', 4, 'desktop nightly guard workflow/script', 'workflow and script absent', 'not-applicable', 'manual', 'desktop-build.yml/script absent; NA signed'],
  ['71db6b7d38', 6, 'desktop canary version alignment', 'canary-version/desktop workflow absent', 'not-applicable', 'manual', 'scripts and workflow absent; NA signed'],
  ['a4332bec13', 1, 'release workflow permissions for desktop job', 'release.yml has no desktop-build job', 'not-applicable', 'manual', 'no desktop job; NA signed'],
  ['6819b036cd', 1, 'nix-build triggers for release branches', 'fork triggers main only', 'not-applicable', 'manual', 'nix-build.yml lines 6-11; NA signed'],
];
const ledger = new Map();
for (const line of fs.readFileSync(path.join(ROOT, '.upstream/ledger.tsv'), 'utf8').split(/\r?\n/).slice(1)) {
  if (!line) continue;
  const fields = line.split('\t');
  if (fields.length > 1) ledger.set(fields[1], fields);
}
const out = [];
for (const [prefix, files, upstream, local, form, probe, evidence] of rows) {
  const sha = [...ledger.keys()].find((candidate) => candidate.startsWith(prefix));
  if (!sha) throw new Error(`no ledger row ${prefix}`);
  out.push([sha, `${files}/${files}`, upstream, local, form, ledger.get(sha)[5] ?? probe, evidence].join('\t'));
}
fs.appendFileSync(path.join(import.meta.dirname, 'audit.tsv'), `${out.join('\n')}\n`);
console.log(`appended ${out.length} G1 rows`);
