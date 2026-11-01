/**
 * Measure what #4521 (prompt slimming) actually removed, on the real inputs.
 *
 * Two surfaces changed, and only one of them is `system.md`:
 *
 * - The system prompt: 2.4.0's single `system.md` became a skeleton plus four
 *   section files. This measures the assembled text of both.
 * - The tool descriptions: `agent-core-v2/src/**\/*.md` reached the model as tool
 *   descriptions. That is where nearly all of the reduction happened, so a
 *   system-prompt-only figure would understate the change by an order of
 *   magnitude.
 *
 * Both sides are the published tags, read through git, so the numbers describe
 * what shipped rather than what a working tree happens to hold. Token estimates
 * use the optimizer's own `estimateTokens`, the same function the benchmark
 * reports with.
 *
 * Usage:
 *   bun scripts/prompt-optimizer/src/measure-4521.ts
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BEFORE_TAG = '@moonshot-ai/kimi-code@2.4.0';
const AFTER_TAG = '@moonshot-ai/kimi-code@2.4.1';

const PROMPT_DIR = 'packages/agent-core-v2/src/app/agentProfileCatalog';
const SOURCE_ROOT = 'packages/agent-core-v2/src';

/** The section files `system.md` delegates to, in injection order. */
const SECTION_FILES: readonly (readonly [placeholder: string, file: string])[] = [
  ['coding_section', 'coding.md'],
  ['delivering_work_section', 'delivering-work.md'],
  ['agents_section', 'project-information.md'],
];

/**
 * Every `.md` under `src/` at a tag that reads as a tool description or a
 * reminder, discovered from the tag itself so a rename cannot silently drop one
 * from the measurement.
 */
function markdownAt(tag: string): string[] {
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', tag, `${SOURCE_ROOT}/`], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (path) =>
        path.endsWith('.md') &&
        /(?:^|\/)(?:agent\/tools|features\/[^/]+\/tools|human\/tool|features\/[^/]+\/injection)\//.test(
          path,
        ),
    )
    .sort();
}

function show(tag: string, path: string): string {
  return execFileSync('git', ['show', `${tag}:${path}`], { encoding: 'utf8' });
}

/** `system.md` at a tag, with the section files spliced into their placeholders. */
function assembledSystemPrompt(tag: string): string {
  let text = show(tag, `${PROMPT_DIR}/system.md`);
  const sectionFiles = tag === BEFORE_TAG ? [] : SECTION_FILES;
  for (const [placeholder, file] of sectionFiles) {
    text = text.replace(`\${${placeholder}}`, `\n${show(tag, `${PROMPT_DIR}/${file}`).trim()}\n`);
  }
  return text;
}

/** Same estimator the benchmark and prune use, so the numbers are comparable. */
function estimateTokens(text: string): number {
  let count = 0;
  for (const char of text) {
    count += char.charCodeAt(0) > 0x4e00 ? 0.5 : 0.25;
  }
  return Math.ceil(count);
}

interface Measure {
  readonly label: string;
  readonly beforeChars: number;
  readonly afterChars: number;
  readonly beforeFiles: number;
  readonly afterFiles: number;
}

function measure(label: string, before: readonly string[], after: readonly string[]): Measure {
  const sum = (parts: readonly string[]) => parts.reduce((total, text) => total + text.length, 0);
  return {
    label,
    beforeChars: sum(before),
    afterChars: sum(after),
    beforeFiles: before.length,
    afterFiles: after.length,
  };
}

function pct(from: number, to: number): string {
  if (from === 0) return 'n/a';
  return `${(((from - to) / from) * 100).toFixed(1)}%`;
}

function line(m: Measure): string {
  const saved = m.beforeChars - m.afterChars;
  return (
    `${m.label.padEnd(22)}` +
    `${String(m.beforeChars).padStart(9)}` +
    `${String(m.afterChars).padStart(9)}` +
    `${String(saved).padStart(9)}` +
    `${pct(m.beforeChars, m.afterChars).padStart(9)}  ` +
    `(${String(m.beforeFiles)} → ${String(m.afterFiles)} files)`
  );
}

const systemBefore = assembledSystemPrompt(BEFORE_TAG);
const systemAfter = assembledSystemPrompt(AFTER_TAG);

const beforePaths = markdownAt(BEFORE_TAG);
const afterPaths = markdownAt(AFTER_TAG);
const beforeTools = beforePaths.map((path) => show(BEFORE_TAG, path));
const afterTools = afterPaths.map((path) => show(AFTER_TAG, path));

const system = measure('system prompt', [systemBefore], [systemAfter]);
const tools = measure('tool descriptions', beforeTools, afterTools);

// A session receives both: the system prompt plus every tool description.
const combined = measure(
  'total prompt surface',
  [systemBefore, ...beforeTools],
  [systemAfter, ...afterTools],
);

console.log('#4521 — prompt slimming, measured from the published tags');
console.log(`before: ${BEFORE_TAG}`);
console.log(`after:  ${AFTER_TAG}`);
console.log('');
console.log(
  'surface'.padEnd(22) +
    'before'.padStart(9) +
    'after'.padStart(9) +
    'saved'.padStart(9) +
    'reduced'.padStart(9),
);
console.log('─'.repeat(76));
for (const m of [system, tools, combined]) console.log(line(m));
console.log('─'.repeat(76));
console.log('');
console.log(
  `tokens: system ${estimateTokens(systemBefore)} → ${estimateTokens(systemAfter)}, ` +
    `tools ${estimateTokens(beforeTools.join(''))} → ${estimateTokens(afterTools.join(''))}`,
);

const perFile: { name: string; saved: number }[] = [];
for (const path of beforePaths) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const before = show(BEFORE_TAG, path);
  const stillThere = afterPaths.includes(path);
  const after = stillThere ? show(AFTER_TAG, path) : '';
  const saved = before.length - after.length;
  if (saved > 0) perFile.push({ name, saved });
}
perFile.sort((a, b) => b.saved - a.saved);

console.log('');
console.log('largest reductions, tool descriptions:');
for (const entry of perFile.slice(0, 10)) {
  console.log(`  ${entry.name.padEnd(28)}${String(-entry.saved).padStart(8)} chars`);
}

// A read-only profile receives the read-only variant, so report it too rather
// than implying one number covers every profile.
const readOnly = readFileSync(`${PROMPT_DIR}/delivering-work-read-only.md`, 'utf8');
console.log('');
console.log(
  `read-only profiles swap delivering-work.md for delivering-work-read-only.md ` +
    `(${String(readFileSync(`${PROMPT_DIR}/delivering-work.md`, 'utf8').length)} → ${String(readOnly.length)} chars there)`,
);
