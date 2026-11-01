import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ALL_LAYERS = ['config', 'packages', 'tests', 'source'];

/**
 * Remove a file the migration replaces, without discarding work it cannot restore.
 *
 * The previous implementation ran `git rm --force`. Measured consequence: with an
 * edit staged in the index — the state a user is in after `git add .` mid-refactor
 * — `git rm --force` deletes the index entry too, and `git show :path` then reports
 * "neither on disk nor in the index". The staged content survives only as an
 * unreachable blob that no command points at, so `--allow-dirty` turned a
 * recoverable state into an unrecoverable one. That is the exact failure the flag
 * is meant to let a reviewer inspect.
 *
 * `git rm` without `--force` refuses that case with a clear message, and its refusal
 * is the safe outcome: the staged blob stays in the index and `git checkout -- path`
 * brings it back. Measured — that restore returns the staged text verbatim.
 *
 * `git rm` is still preferred over a plain unlink for a tracked file, because it
 * records the deletion in the index so `git status` shows a rename or delete rather
 * than an untracked leftover. Three outcomes are handled:
 *
 * 1. `git rm` succeeds — the file was tracked and clean, so the deletion is staged.
 * 2. `git rm` refuses because the path has staged or unstaged changes — the file is
 *    unlinked from the worktree only, leaving the index entry intact and restorable.
 * 3. `git rm --ignore-unmatch` finds nothing (untracked path) — the file is unlinked.
 *
 * A journal `remove` entry always carries the original content, so `revert` restores
 * the bytes in every case; this function only decides what the worktree and index
 * look like in between.
 */
function deleteFile(root, file) {
  const absolute = join(root, file);
  if (!existsSync(absolute)) return;

  const staged = Bun.spawnSync(['git', 'rm', '--quiet', '--ignore-unmatch', '--', file], { cwd: root });
  if (staged.exitCode === 0 && !existsSync(absolute)) return;

  /**
   * The index holds a version the worktree no longer matches, or the path was never
   * tracked. Either way the worktree copy goes and the index is left alone.
   */
  rmSync(absolute, { force: true });
}

/**
 * Records every proposed change and applies them only on commit().
 *
 * The journal is the deliverable, not a side effect: an automatic rewrite that
 * cannot be reviewed afterwards is worse than no rewrite, because the condition
 * that justified it is gone by the time anyone reads the diff.
 */
export function createJournal(layersOption) {
  const layers = layersOption ?? ALL_LAYERS;
  const pending = new Map();
  const fileEdits = [];
  const removals = [];
  const notes = [];
  const forcedSkips = new Map();
  const perLayer = new Map(
    layers.map((name) => [name, { name, changes: [], skipped: [] }]),
  );

  const enabled = (layer) => perLayer.has(layer);

  function readFile(file) {
    return pending.has(file) ? pending.get(file) : undefined;
  }

  function set(file, after, layer, detail, before) {
    if (!enabled(layer)) return;
    const previous = pending.has(file) ? pending.get(file) : before;
    if (previous === after) return;
    pending.set(file, after);
    const entry = { kind: 'edit', layer, file, detail, before: previous, after };
    fileEdits.push(entry);
    perLayer.get(layer).changes.push(entry);
  }

  /** The current text of a file as the running migration sees it. */
  function current(file, fallback) {
    return pending.has(file) ? pending.get(file) : fallback;
  }

  function create(file, content, layer, detail) {
    if (!enabled(layer)) return;
    pending.set(file, content);
    const entry = { kind: 'create', layer, file, detail, after: content };
    fileEdits.push(entry);
    perLayer.get(layer).changes.push(entry);
  }

  function remove(file, layer, detail, content) {
    if (!enabled(layer)) return;
    const entry = { kind: 'remove', layer, file, detail, before: content };
    removals.push(entry);
    perLayer.get(layer).changes.push(entry);
  }

  /**
   * A skip is a report, not a write, so it lands even when the layer is off.
   *
   * `--no-source` means "do not rewrite my `node:` calls", not "do not tell me
   * this code calls `v8.queryObjects` and will throw under Bun" — measured
   * before this distinction, passing `--only config,packages,tests` silenced
   * the node-gap warnings along with the rewrites, which is the one report a
   * migration run must never lose. A layer that is not running at all still
   * has nowhere to record, so the skip is kept in a dedicated bucket that
   * `layers()` always includes.
   */
  function skip(file, layer, reason) {
    if (!perLayer.has(layer)) {
      const bucket = forcedSkips.get(layer) ?? [];
      bucket.push({ kind: 'skip', layer, file, reason });
      forcedSkips.set(layer, bucket);
      return;
    }
    perLayer.get(layer).skipped.push({ kind: 'skip', layer, file, reason });
  }

  function note(layer, detail) {
    if (!enabled(layer)) return;
    const entry = { kind: 'note', layer, detail };
    perLayer.get(layer).changes.push(entry);
    notes.push(entry);
  }

  function commit(root) {
    const failures = [];
    for (const [file, content] of pending) {
      const absolute = join(root, file);
      try {
        mkdirSync(dirname(absolute), { recursive: true });
        /**
         * Write to a sibling and rename into place. A crash mid-write used to
         * leave a truncated source file even though the journal existed; the
         * previous bytes are still recorded, but a torn file is a worse starting
         * point for the reviewer than a file that was never touched.
         */
        const temp = `${absolute}.${process.pid}.tmp`;
        writeFileSync(temp, content, 'utf8');
        try {
          renameSync(temp, absolute);
        } catch (error) {
          rmSync(temp, { force: true });
          throw error;
        }
      } catch (error) {
        failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const item of removals) {
      try {
        deleteFile(root, item.file);
      } catch (error) {
        failures.push(`${item.file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `bun-migrate: ${failures.length} write(s) failed after the journal was recorded:\n  ${failures.join('\n  ')}`,
      );
    }
  }

  return {
    layersRun: layers,
    enabled,
    readFile,
    current,
    set,
    create,
    remove,
    skip,
    note,
    get changes() {
      return [...fileEdits, ...removals, ...notes];
    },
    get removals() {
      return removals;
    },
    layers() {
      const run = [...perLayer.values()];
      /**
       * A layer that only produced forced skips (it was excluded by --only but
       * still has a report) appears so the report cannot lose the findings;
       * `changes` is empty for it, which summarize renders as 0 change(s).
       */
      for (const [name, bucket] of forcedSkips) {
        if (perLayer.has(name)) continue;
        run.push({ name, changes: [], skipped: bucket });
      }
      return run;
    },
    commit,
  };
}
