#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { createJournal } from './journal.mjs';
import { loadProject } from './project.mjs';
import { journalToMarkdown, summarize } from './report.mjs';

const USAGE = [
  'bun tools/bun-migrate/src/cli.mjs <command> [options]',
  '',
  'commands',
  '  scan                 report what a migration would change (writes nothing)',
  '  apply                write the changes and record a journal',
  '  revert <journal>     undo a journal file',
  '  help                 print this message',
  '',
  'options',
  '  --root <dir>         project root (default: nearest package.json upward from cwd)',
  '  --only <layers>      comma list of config,packages,tests,source',
  '  --no-source          shorthand for --only config,packages,tests',
  '  --json               machine-readable output',
  '  --allow-dirty        apply even when git reports uncommitted changes, or outside a git repository',
  '',
  'layers',
  '  config    .npmrc / .nvmrc / engines / pnpm+npx scripts / CI setup steps',
  '  packages  pnpm-workspace.yaml globs, lockfiles, vitest project configs',
  '  tests     vitest and jest imports rewritten to bun:test',
  '  source    node: API calls with a condition-checked Bun replacement',
].join('\n');

/**
 * The layers a `--only` value may name.
 *
 * `journal.enabled()` treats an unknown name as "not requested", so a typo used to
 * produce a run that changed nothing and exited 0 — indistinguishable from a
 * project with nothing to migrate. The list is validated up front instead.
 */
const LAYER_NAMES = ['config', 'packages', 'tests', 'source'];
const COMMANDS = new Set(['scan', 'apply', 'revert', 'help']);

export class UsageError extends Error {}

function layerList(value, flag) {
  if (value === undefined || value === '') {
    throw new UsageError(`${flag} needs a comma-separated layer list, e.g. --only config,packages`);
  }
  const names = value.split(',').map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new UsageError(`${flag} needs a comma-separated layer list, e.g. --only config,packages`);
  }
  const unknown = names.filter((name) => !LAYER_NAMES.includes(name));
  if (unknown.length > 0) {
    throw new UsageError(
      `${flag} has unknown layer(s): ${unknown.join(', ')}. Known layers: ${LAYER_NAMES.join(', ')}`,
    );
  }
  return names;
}

export function parseArgs(argv) {
  let index = 0;
  let command = 'scan';
  if (argv[0] !== undefined && !argv[0].startsWith('-')) {
    command = argv[0];
    if (!COMMANDS.has(command)) {
      throw new UsageError(
        `unknown command '${command}'. Known commands: ${[...COMMANDS].join(', ')}`,
      );
    }
    index = 1;
  }
  const options = { command, json: false, allowDirty: false, help: false };
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError('--root needs a directory path');
      }
      options.root = value;
    } else if (argument === '--only') {
      options.layers = layerList(argv[++index], '--only');
    } else if (argument === '--no-source') {
      options.layers = ['config', 'packages', 'tests'];
    } else if (argument === '--json') {
      options.json = true;
    } else if (argument === '--allow-dirty') {
      options.allowDirty = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument.startsWith('--')) {
      throw new UsageError(`unknown option ${argument}`);
    } else {
      /**
       * A positional argument is only meaningful for `revert`, where it names
       * the journal. `--help` used to be swallowed because the option loop
       * started at index 1, and an unknown command used to run a scan and exit
       * 0, so a typo was indistinguishable from a project with nothing to do.
       */
      if (command !== 'revert') {
        throw new UsageError(
          `unexpected argument '${argument}': the command must come first, and only revert takes a path`,
        );
      }
      if (options.target !== undefined) {
        throw new UsageError(`unexpected argument '${argument}': revert takes one journal path`);
      }
      options.target = argument;
    }
  }
  if (command === 'revert' && options.target === undefined) {
    throw new UsageError('revert needs the journal path: bun cli.mjs revert <journal.json>');
  }
  if (options.layers !== undefined) options.layers = [...new Set(options.layers)];
  return options;
}

function discoverRoot() {
  let current = process.cwd();
  for (;;) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

function gitIsDirty(root) {
  const result = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: root });
  if (result.exitCode !== 0) return;
  return result.stdout.toString().trim().length > 0;
}

/**
 * Whether `apply` may write, given the project's git state.
 *
 * Three states, each with its own answer:
 *
 * - dirty (`true` from gitIsDirty) — refuse unless `--allow-dirty`, as before.
 * - clean (`false`) — proceed.
 * - not a git repository (`undefined`) — also refuse by default. A migration
 *   outside git cannot be diffed, which is the same property the dirty check
 *   protects; measured before this branch, `apply` in a non-repo silently
 *   wrote everything while the dirty guard's promise ("a migration you cannot
 *   diff is a migration you cannot review") held everywhere else. `--allow-dirty`
 *   is the explicit way through, and the message says what it is agreeing to.
 */
function applyMayProceed(root, allowDirty) {
  const state = gitIsDirty(root);
  if (state === false) return { ok: true };
  if (state === true && allowDirty) return { ok: true };
  if (state === undefined && allowDirty) return { ok: true };
  if (state === true) {
    return { ok: false, message: 'bun-migrate: uncommitted changes present. Commit first, or pass --allow-dirty.' };
  }
  return {
    ok: false,
    message:
      'bun-migrate: this directory is not a git repository, so the migration cannot be diffed. Run inside a repo, or pass --allow-dirty to proceed without one.',
  };
}

function printHuman(report) {
  const lines = [report.summary, ''];
  for (const layer of report.layers) {
    lines.push(`[${layer.name}] ${layer.changes.length} change(s), ${layer.skipped.length} skipped`);
    for (const change of layer.changes) {
      if (change.kind === 'note') {
        lines.push(`  NOTE   ${change.detail}`);
        continue;
      }
      lines.push(`  ${change.kind.padEnd(6)} ${change.file}`);
      if (change.detail) lines.push(`         ${change.detail}`);
    }
    for (const skipped of layer.skipped) {
      lines.push(`  SKIP   ${skipped.file}`);
      lines.push(`         ${skipped.reason}`);
    }
    lines.push('');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function writeFileAtomic(path, content) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, 'utf8');
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function gitHasStagedDeletion(root, file) {
  const result = Bun.spawnSync(['git', 'diff', '--cached', '--name-only', '--diff-filter=D', '--', file], {
    cwd: root,
  });
  if (result.exitCode !== 0) return false;
  return result.stdout
    .toString()
    .split('\n')
    .map((line) => line.trim())
    .includes(file);
}

/**
 * After restoring a removed file, undo the deletion `git rm` staged in the index.
 *
 * Without this, revert left the bytes on disk but `git status` still reported a
 * staged deletion plus an untracked file, and `git checkout -- <path>` could not
 * bring the entry back because the index no longer had it.
 */
function restoreRemovalIndex(root, file) {
  if (!gitHasStagedDeletion(root, file)) return;
  Bun.spawnSync(['git', 'add', '--', file], { cwd: root });
}

function warnAboutJournalSecrets(root, journal) {
  const sensitive = journal.removals.filter(
    (item) => item.file === '.npmrc' || /(?:^|_)(?:authToken|password)\b/m.test(String(item.before ?? '')),
  );
  if (sensitive.length === 0) return;
  const ignored = Bun.spawnSync(['git', 'check-ignore', '-q', '.bun-migrate'], { cwd: root });
  if (ignored.exitCode === 0) return;
  const files = [...new Set(sensitive.map((item) => item.file))].join(', ');
  process.stderr.write(
    `bun-migrate: the journal records ${files} verbatim (it may contain registry credentials) and .bun-migrate/ is not git-ignored. Add ".bun-migrate/" to .gitignore before committing.\n`,
  );
}

function revert(root, journalPath) {
  const requested = resolve(journalPath);
  const candidate = requested.endsWith('.md') ? requested.replace(/\.md$/, '.json') : requested;
  const absolute = existsSync(candidate) ? candidate : requested;
  if (!existsSync(absolute)) {
    process.stderr.write(`bun-migrate: no journal at ${absolute}\n`);
    process.exit(1);
  }
  let journal;
  try {
    journal = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch {
    process.stderr.write(
      `bun-migrate: ${basename(absolute)} is not machine readable; pass the .json journal, not the .md summary\n`,
    );
    process.exit(1);
  }
  let restored = 0;
  const discarded = [];
  for (const change of [...journal.changes].toReversed()) {
    if (change.kind === 'note' || !change.file) continue;
    const target = join(root, change.file);
    const inside = relative(root, target);
    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      process.stderr.write(`revert: refusing to write outside the project root: ${change.file}\n`);
      continue;
    }
    /**
     * An edit whose `before` is undefined is a file the migration brought into
     * existence — `journal.set` records the pre-image only when one exists. The
     * timeout preload the packages layer writes lands here: measured before this
     * branch, `revert` hit `before === undefined`, printed nothing, and left
     * `bun-migrate.timeout.ts` on disk after reporting every other file
     * restored. Undoing it is the same operation as undoing a `create`, with
     * the same staged-edit protection: `git rm` without `--force`, falling back
     * to unlinking the worktree copy when git refuses.
     */
    if (change.kind === 'edit' && change.before === undefined) {
      const result = Bun.spawnSync(
        ['git', 'rm', '--quiet', '--ignore-unmatch', '--', change.file],
        { cwd: root },
      );
      if (result.exitCode === 0 && !existsSync(target)) {
        restored += 1;
        continue;
      }
      if (existsSync(target)) {
        rmSync(target, { force: true });
        discarded.push(change.file);
      }
      restored += 1;
      continue;
    }
    if (change.kind === 'create') {
      /**
       * The migration created this file, so undoing it means removing it. Same rule
       * as `journal.commit`'s remove path: no `--force`. Measured before this fix,
       * a created file that the user had staged (`git add bunfig.toml` after
       * editing it) was wiped from index and worktree alike, and `git show :path`
       * then said "neither on disk nor in the index" — the staged text was gone.
       *
       * `git rm` without `--force` refuses in that state, so the worktree copy is
       * unlinked instead and the index entry survives; the caller prints a note
       * saying so, because a file left "deleted but still staged" is something the
       * user has to look at rather than something to discover later.
       */
      const result = Bun.spawnSync(
        ['git', 'rm', '--quiet', '--ignore-unmatch', '--', change.file],
        { cwd: root },
      );
      if (result.exitCode === 0 && !existsSync(target)) {
        restored += 1;
        continue;
      }
      if (existsSync(target)) {
        rmSync(target, { force: true });
        discarded.push(change.file);
      }
      restored += 1;
      continue;
    }
    if (change.before === undefined) {
      if (change.kind === 'remove') {
        process.stdout.write(
          `revert: ${change.file} was removed and its content was not recorded; restore it yourself\n`,
        );
      }
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileAtomic(target, change.before);
    if (change.kind === 'remove') restoreRemovalIndex(root, change.file);
    restored += 1;
  }
  if (discarded.length > 0) {
    process.stdout.write(
      `revert: ${discarded.length} created file(s) had staged changes, so the worktree copy was removed and the index entry kept: ${discarded.join(', ')}\n`,
    );
    process.stdout.write('revert: run `git checkout -- <path>` to bring the staged version back\n');
  }
  process.stdout.write(`revert: ${restored} file(s) restored from ${basename(absolute)}\n`);
}

export async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const project = loadProject(options.root ?? discoverRoot());
  if (options.command === 'revert') {
    revert(project.root, options.target);
    return;
  }
  if (options.command === 'apply') {
    const gate = applyMayProceed(project.root, options.allowDirty);
    if (!gate.ok) {
      process.stderr.write(`${gate.message}\n`);
      process.exit(1);
    }
  }
  const journal = createJournal(options.layers);
  /**
   * Load a layer only when it is going to run. The CLI used to import all six
   * layers (and TypeScript) even for `revert` and `help`, which never inspect a
   * source file; every end-to-end test paid that startup cost per process.
   */
  if (journal.enabled('config')) {
    const { applyConfigLayer } = await import('./layers/config.mjs');
    applyConfigLayer(project, journal);
  }
  if (journal.enabled('packages')) {
    const [{ applyPackageLayer }, { applyPackageReplacementLayer }] = await Promise.all([
      import('./layers/packages.mjs'),
      import('./layers/package-replacement.mjs'),
    ]);
    applyPackageLayer(project, journal);
    applyPackageReplacementLayer(project, journal);
  }
  if (journal.enabled('tests')) {
    const { applyTestLayer } = await import('./layers/tests.mjs');
    applyTestLayer(project, journal);
  }
  if (journal.enabled('source')) {
    const { applySourceLayer } = await import('./layers/source.mjs');
    applySourceLayer(project, journal);
  }
  const { applyNodeGapLayer } = await import('./layers/node-gaps.mjs');
  applyNodeGapLayer(project, journal);
  const report = summarize(project, journal, options.command);
  report.layers = journal.layers();

  if (options.command !== 'apply') {
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printHuman(report);
    return;
  }

  const meta = {
    createdAt: new Date().toISOString(),
    root: project.root,
    bun: Bun.version,
    layers: journal.layersRun,
  };
  const directory = join(project.root, '.bun-migrate');
  mkdirSync(directory, { recursive: true });
  const stamp = meta.createdAt.replaceAll(/[:.]/g, '-');
  const jsonPath = join(directory, `journal-${stamp}.json`);
  const markdownPath = join(directory, `journal-${stamp}.md`);
  const payload = {
    ...meta,
    changes: journal.changes.map((change) => ({
      kind: change.kind,
      layer: change.layer,
      file: change.file,
      detail: change.detail,
      before: change.before,
      after: change.after,
    })),
    removed: journal.removals.map((item) => item.file),
    skipped: journal.layers().flatMap((layer) => layer.skipped),
  };
  /**
   * The journal is written first. It carries every pre-image `revert` needs, so a
   * crash during the write phase leaves a file that can still be undone; writing
   * it after `commit` left changes on disk with no record of how to reverse them.
   */
  warnAboutJournalSecrets(project.root, journal);
  writeFileAtomic(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  writeFileAtomic(markdownPath, journalToMarkdown(journal, meta));
  try {
    journal.commit(project.root);
  } catch (error) {
    process.stderr.write(
      `bun-migrate: writing the changes failed: ${error instanceof Error ? error.message : String(error)}\nThe journal at ${jsonPath} records every pre-image, so the files it names can be restored with \`bun tools/bun-migrate/src/cli.mjs revert ${jsonPath}\`.\n`,
    );
    process.exit(1);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...report, journal: markdownPath }, null, 2)}\n`);
  } else {
    printHuman(report);
    process.stdout.write(`journal: ${markdownPath}\n`);
    process.stdout.write(`journal: ${jsonPath}\n`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`bun-migrate: ${error.message}\n\n${USAGE}\n`);
      process.exit(2);
    }
    throw error;
  }
}
