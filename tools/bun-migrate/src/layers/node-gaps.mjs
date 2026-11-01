import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from '../ast.mjs';
import { activeGaps, findMissingUsages } from '../node-gaps.mjs';

function readText(project, path) {
  const absolute = join(project.root, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;
}

/**
 * Report source that calls a `node:` member Bun does not provide.
 *
 * This layer produces no edits on purpose. There is no safe automatic rewrite:
 * the member is missing, so the only correct action is either a workaround
 * chosen by a person or a dependency that does not need it. A silent rewrite
 * would trade a run-time crash for a different run-time crash.
 *
 * The layer runs regardless of whether the `source` rewrites were requested:
 * `--only config,packages` or `--no-source` turns off the rewrites, not the
 * warning that a call will throw on the first run. The journal records the
 * skips even for a layer that is not running (see `createJournal`), so the
 * report carries them and `apply` writes nothing extra.
 */
export function applyNodeGapLayer(project, journal) {
  const gaps = activeGaps();
  if (gaps.length === 0) {
    journal.note('source', 'this Bun implements every recorded node: gap; the gap list can be trimmed');
    return;
  }

  for (const file of project.files) {
    const text = journal.readFile(file) ?? readText(project, file);
    if (!text) continue;
    if (!text.includes('node:')) continue;
    // `parse` records syntax errors as diagnostics rather than throwing, so this
    // only guards a non-string input reaching it — which the text check above already
    // rules out. Kept as a statement of the invariant, not as a live defence.
    const sourceFile = parse(file, text);
    const hits = findMissingUsages(text, gaps, sourceFile);
    for (const gap of hits) {
      journal.skip(
        file,
        'source',
        `${gap.module} exports no ${gap.member} in this Bun (${Bun.version}), so this call fails at run time — ${gap.workaround}`,
      );
    }
  }
}
