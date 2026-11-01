export function summarize(project, journal, command) {
  const layers = journal.layers();
  const edits = journal.changes;
  const removals = journal.removals;
  const skips = layers.reduce((sum, layer) => sum + layer.skipped.length, 0);
  return {
    command,
    root: project.root,
    layers,
    removed: removals.map((item) => item.file),
    summary: [
      `${edits.length} file change(s)`,
      `${removals.length} removal(s)`,
      `${skips} skipped`,
      command === 'apply' ? 'written' : 'dry run',
    ].join(', '),
  };
}

/**
 * Render a journal back into readable Markdown.
 *
 * This is what makes an automatic rewrite reviewable: each entry states what
 * changed and, for a source rewrite, the condition that made it safe.
 */
export function journalToMarkdown(journal, meta) {
  const lines = [
    `# bun-migrate journal — ${meta.createdAt}`,
    '',
    `- root: \`${meta.root}\``,
    `- bun: ${meta.bun}`,
    `- layers: ${meta.layers.join(', ')}`,
    '',
    '## Summary',
    '',
    '| layer | changes | skipped |',
    '| --- | --- | --- |',
  ];
  for (const layer of meta.layers) {
    const bucket = journal.layers().find((item) => item.name === layer);
    lines.push(`| ${layer} | ${bucket ? bucket.changes.length : 0} | ${bucket ? bucket.skipped.length : 0} |`);
  }
  lines.push('');
  for (const layer of journal.layers()) {
    if (layer.changes.length === 0 && layer.skipped.length === 0) continue;
    lines.push(`## ${layer.name}`);
    lines.push('');
    for (const change of layer.changes) {
      if (change.kind === 'note') {
        lines.push(`- _note_: ${change.detail}`);
        continue;
      }
      const verb = change.kind === 'create' ? 'create' : change.kind === 'remove' ? 'remove' : 'edit';
      lines.push(`- **${verb}** \`${change.file}\`${change.detail ? ` — ${change.detail}` : ''}`);
      if (change.kind === 'edit' && change.before !== undefined) {
        lines.push('');
        lines.push('  ```diff');
        const beforeLines = String(change.before).split('\n');
        const afterLines = String(change.after).split('\n');
        for (const line of beforeLines.slice(0, DIFF_LINE_LIMIT)) lines.push(`  - ${line}`);
        for (const line of afterLines.slice(0, DIFF_LINE_LIMIT)) lines.push(`  + ${line}`);
        lines.push('  ```');
        /**
         * The cap stays, because a 2000-line file would bury the entry it is meant to
         * explain. What used to be missing is the statement that it happened: a diff
         * silently cut at 40 lines reads as the complete change, so a reviewer could
         * approve a journal that did not contain the change. The count and the omitted
         * line total are printed instead.
         */
        if (beforeLines.length > DIFF_LINE_LIMIT || afterLines.length > DIFF_LINE_LIMIT) {
          lines.push(
            `  _diff truncated: showing ${Math.min(beforeLines.length, DIFF_LINE_LIMIT)} of ${beforeLines.length} line(s) before and ${Math.min(afterLines.length, DIFF_LINE_LIMIT)} of ${afterLines.length} line(s) after; read the file or the .json journal for the rest_`,
          );
        }
        lines.push('');
      }
    }
    if (layer.skipped.length > 0) {
      lines.push('');
      lines.push('  Skipped:');
      lines.push('');
      for (const item of layer.skipped) {
        lines.push(`  - \`${item.file}\` — ${item.reason}`);
      }
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * How many before and after lines a journal diff shows before it says it truncated.
 *
 * Kept as a named constant so the truncation notice and the loop cannot drift apart:
 * the notice reports against this number, so a future change to it updates both.
 */
export const DIFF_LINE_LIMIT = 40;
