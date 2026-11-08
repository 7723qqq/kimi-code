/**
 * R8 — three-axis measurement of the prompt optimizer's rewrite.
 *
 * design.md §5.2 fixes three axes because no single one separates a real fix
 * from a shifted defect: the length ratio (`len(out) / len(draft)`), the share
 * of the draft's content words that survive into the rewrite, and the count of
 * added requirements — imperative clauses carrying content the draft does not.
 * The draft set is the six from research-prompt-rewriting.md §7.4, pinned here
 * so a run today is comparable with the baseline recorded there.
 *
 * A failed call is recorded as a failure and left out of the aggregate rather
 * than counted as an empty rewrite: the first version of this measurement
 * conflated the two and produced a run of false negatives.
 */

import {
  PROMPT_OPTIMIZER_DRAFT_CLOSE,
  PROMPT_OPTIMIZER_DRAFT_OPEN,
  PROMPT_OPTIMIZER_SYSTEM_PROMPT,
} from '../../../../packages/agent-core-v2/src/features/promptOptimizer/promptOptimizer';
import type { LLMCaller, RunnerConfig } from '../benchmark/runner';
import { callWithRetry } from '../benchmark/runner';

export const MEASURE_DRAFTS: readonly string[] = [
  '请分析如何全部最优方案和最完整方案 减少打补丁和便宜',
  '请完整进行优化',
  '开始完整推进 需要事后验收 提示词需要专业优质',
  '最重要的问题是现在的提示词会从以前的详细变成现在的扩句一样',
  '修一下登录那个 bug',
  'fix the auth thing',
];

const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'to',
  'of',
  'and',
  'or',
  'for',
  'in',
  'on',
  'with',
  'at',
  'by',
  'from',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'i',
  'you',
  'we',
  'they',
  'he',
  'she',
  'please',
  'do',
  'does',
  'not',
  'no',
  'into',
  'than',
  'then',
  '的',
  '了',
  '和',
  '与',
  '及',
  '或',
  '在',
  '是',
  '我',
  '你',
  '他',
  '她',
  '它',
  '我们',
  '你们',
  '他们',
  '请',
  '要',
  '有',
  '这',
  '那',
  '这个',
  '那个',
  '就',
  '也',
  '都',
  '而',
  '而且',
  '但是',
  '但',
  '如果',
  '因为',
  '所以',
  '然后',
  '一个',
  '一些',
  '一下',
  '并',
  '且',
  '为',
  '以',
  '等',
  '对',
  '把',
  '被',
  '从',
  '到',
  '上',
  '下',
  '中',
  '里',
  '个',
  '些',
  '想',
  '可以',
  '能够',
]);

const IMPERATIVE_MARKERS: readonly string[] = [
  '请',
  '需要',
  '必须',
  '应该',
  '确保',
  '要求',
  '使用',
  '运行',
  '执行',
  '修改',
  '添加',
  '删除',
  '检查',
  '确认',
  '实现',
  '完成',
  '提供',
  '保持',
  '避免',
  '不要',
  '请勿',
  '试着',
  '尝试',
  'must',
  'should',
  'ensure',
  'make sure',
  'add',
  'remove',
  'delete',
  'run',
  'execute',
  'update',
  'fix',
  'implement',
  'provide',
  'keep',
  'avoid',
  'do not',
  "don't",
  'use',
  'check',
  'confirm',
  'write',
  'create',
  'please',
  'try',
];

export interface DraftMeasurement {
  readonly draft: string;
  readonly output: string;
  readonly lengthRatio: number;
  readonly retention: number;
  readonly addedRequirements: number;
}

export interface MeasureFailure {
  readonly draft: string;
  readonly error: string;
}

export interface MeasureReport {
  readonly model: string;
  readonly dryRun: boolean;
  readonly repetitions: number;
  /** One entry per draft, aggregated over its repetitions. */
  readonly drafts: readonly DraftMeasurement[];
  /** Every individual run, repetitions included. */
  readonly runs: readonly DraftMeasurement[];
  readonly failures: readonly MeasureFailure[];
}

function contentWords(text: string): string[] {
  return text
    .split(/[\s\p{P}\p{S}]+/u)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0 && !STOPWORDS.has(word));
}

function clauses(text: string): string[] {
  return text
    .split(/[。！？；.!?;\n]+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/**
 * The production input for a rewrite with no recent turns: the working
 * directory, then the draft inside its fence. `fenceSafe` in the engine escapes
 * a literal closing tag in the draft, and so does this.
 */
export function buildMeasureInput(draft: string, cwd: string): string {
  const fenced = draft
    .replaceAll(PROMPT_OPTIMIZER_DRAFT_CLOSE, '&lt;/draft&gt;')
    .replaceAll(PROMPT_OPTIMIZER_DRAFT_OPEN, '&lt;draft&gt;');
  return `Working directory: ${cwd}\n\n${PROMPT_OPTIMIZER_DRAFT_OPEN}\n${fenced}\n${PROMPT_OPTIMIZER_DRAFT_CLOSE}`;
}

export function lengthRatio(draft: string, output: string): number {
  return output.length / Math.max(draft.length, 1);
}

export function originalWordRetention(draft: string, output: string): number {
  const draftWords = contentWords(draft);
  if (draftWords.length === 0) return 1;
  const haystack = output.toLowerCase();
  const kept = draftWords.filter((word) => haystack.includes(word)).length;
  return kept / draftWords.length;
}

export function addedRequirementCount(draft: string, output: string): number {
  const draftWords = new Set(contentWords(draft));
  let count = 0;
  for (const clause of clauses(output)) {
    const lowered = clause.toLowerCase();
    const imperative = IMPERATIVE_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()));
    if (!imperative) continue;
    if (contentWords(clause).some((word) => !draftWords.has(word))) count += 1;
  }
  return count;
}

export function measureDraft(draft: string, output: string): DraftMeasurement {
  return {
    draft,
    output,
    lengthRatio: lengthRatio(draft, output),
    retention: originalWordRetention(draft, output),
    addedRequirements: addedRequirementCount(draft, output),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Aggregate one draft's repetitions: the median of every axis, and the output
 * of the run closest to the median length ratio so the report shows a
 * representative rewrite rather than an arbitrary one.
 */
export function aggregateMeasurements(measurements: readonly DraftMeasurement[]): DraftMeasurement {
  const first = measurements[0];
  if (first === undefined) throw new Error('cannot aggregate an empty measurement set');
  const representative = [...measurements].sort(
    (left, right) =>
      Math.abs(left.lengthRatio - median(measurements.map((m) => m.lengthRatio))) -
      Math.abs(right.lengthRatio - median(measurements.map((m) => m.lengthRatio))),
  )[0]!;
  return {
    draft: first.draft,
    output: representative.output,
    lengthRatio: median(measurements.map((m) => m.lengthRatio)),
    retention: median(measurements.map((m) => m.retention)),
    addedRequirements: median(measurements.map((m) => m.addedRequirements)),
  };
}

export async function runMeasurement(options: {
  readonly drafts?: readonly string[];
  readonly cwd: string;
  readonly repetitions: number;
  readonly model: string;
  readonly runner: RunnerConfig;
  readonly caller: LLMCaller;
  readonly dryRun: boolean;
}): Promise<MeasureReport> {
  const drafts = options.drafts ?? MEASURE_DRAFTS;
  const runs: DraftMeasurement[] = [];
  const failures: MeasureFailure[] = [];

  for (const draft of drafts) {
    for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
      try {
        const response = await callWithRetry(
          options.caller,
          PROMPT_OPTIMIZER_SYSTEM_PROMPT,
          [buildMeasureInput(draft, options.cwd)],
          options.runner,
          undefined,
          `measure "${draft}" repetition ${String(repetition + 1)}`,
        );
        runs.push(measureDraft(draft, response.content));
      } catch (error) {
        failures.push({ draft, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const aggregated: DraftMeasurement[] = [];
  for (const draft of drafts) {
    const mine = runs.filter((run) => run.draft === draft);
    if (mine.length > 0) aggregated.push(aggregateMeasurements(mine));
  }

  return {
    model: options.model,
    dryRun: options.dryRun,
    repetitions: options.repetitions,
    drafts: aggregated,
    runs,
    failures,
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface MeasureAxisComparison {
  readonly axis: 'lengthRatio' | 'retention' | 'addedRequirements';
  readonly label: string;
  readonly current: number;
  readonly baseline: number;
  readonly delta: number;
}

const COMPARISON_AXES = [
  {
    axis: 'lengthRatio',
    label: 'len ratio',
    pick: (draft: DraftMeasurement) => draft.lengthRatio,
  },
  {
    axis: 'retention',
    label: 'retention',
    pick: (draft: DraftMeasurement) => draft.retention,
  },
  {
    axis: 'addedRequirements',
    label: 'added',
    pick: (draft: DraftMeasurement) => draft.addedRequirements,
  },
] as const;

export function compareMeasureReports(
  current: MeasureReport,
  baseline: MeasureReport,
): readonly MeasureAxisComparison[] {
  if (current.drafts.length === 0 || baseline.drafts.length === 0) return [];
  return COMPARISON_AXES.map(({ axis, label, pick }) => {
    const now = mean(current.drafts.map(pick));
    const before = mean(baseline.drafts.map(pick));
    return { axis, label, current: now, baseline: before, delta: now - before };
  });
}

export function formatMeasureComparison(comparisons: readonly MeasureAxisComparison[]): string {
  if (comparisons.length === 0) {
    return 'against the baseline: unavailable (one side has no drafts)';
  }
  const lines = ['against the baseline:'];
  for (const entry of comparisons) {
    const sign = entry.delta >= 0 ? '+' : '';
    lines.push(
      `  ${entry.label.padEnd(10)} ${entry.current.toFixed(2)} vs ${entry.baseline.toFixed(2)}` +
        `  (${sign}${entry.delta.toFixed(2)})`,
    );
  }
  return lines.join('\n');
}

export function formatMeasureReport(report: MeasureReport): string {
  const lines: string[] = [
    `Prompt optimizer rewrite — three-axis measurement (model: ${report.model})`,
  ];
  if (report.dryRun) {
    lines.push('dry-run: responses do not depend on the prompt, so nothing below is a verdict.');
  }
  lines.push('');
  lines.push(
    'draft'.padEnd(46) + 'len ratio'.padStart(10) + 'retention'.padStart(11) + 'added'.padStart(7),
  );
  for (const draft of report.drafts) {
    lines.push(
      truncate(draft.draft, 44).padEnd(46) +
        draft.lengthRatio.toFixed(2).padStart(10) +
        draft.retention.toFixed(2).padStart(11) +
        String(draft.addedRequirements).padStart(7),
    );
  }
  if (report.drafts.length > 0) {
    lines.push('─'.repeat(74));
    lines.push(
      'mean'.padEnd(46) +
        mean(report.drafts.map((d) => d.lengthRatio))
          .toFixed(2)
          .padStart(10) +
        mean(report.drafts.map((d) => d.retention))
          .toFixed(2)
          .padStart(11) +
        mean(report.drafts.map((d) => d.addedRequirements))
          .toFixed(2)
          .padStart(7),
    );
  }
  if (report.failures.length > 0) {
    lines.push('');
    lines.push(`failed calls: ${String(report.failures.length)}`);
    for (const failure of report.failures) {
      lines.push(`  ${truncate(failure.draft, 40)} — ${truncate(failure.error, 60)}`);
    }
  }
  return lines.join('\n');
}
