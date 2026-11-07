import { calibrate, type CalibrationBucket, type CalibrationSample } from './metacognition';

export interface RecallEvaluation {
  readonly queries: number;
  readonly hitAt1: number;
  readonly hitAt5: number;
  readonly mrr: number;
}

export interface ExtendedRecallEvaluation extends RecallEvaluation {
  readonly retention: number;
  readonly interference: number;
  readonly calibration: readonly CalibrationBucket[];
  readonly costMs: number;
}

export interface EvaluationOptions {
  readonly k?: number;
  readonly retention?: number;
  readonly interference?: number;
  readonly calibration?: readonly CalibrationBucket[];
  readonly costMs?: number;
}

export function evaluateExtended(
  results: readonly (readonly string[])[],
  groundTruth: readonly (readonly string[])[],
  options: EvaluationOptions = {},
): ExtendedRecallEvaluation {
  return {
    ...evaluateRecall(results, groundTruth, options.k ?? 5),
    retention: options.retention ?? 0,
    interference: options.interference ?? 0,
    calibration: options.calibration ?? [],
    costMs: options.costMs ?? 0,
  };
}

export function evaluateRecall(
  results: readonly (readonly string[])[],
  groundTruth: readonly (readonly string[])[],
  k = 5,
): RecallEvaluation {
  const queries = Math.min(results.length, groundTruth.length);
  let hitAt1 = 0;
  let hitAt5 = 0;
  let reciprocal = 0;
  for (let index = 0; index < queries; index++) {
    const ids = results[index]!;
    const expected = new Set(groundTruth[index]!);
    const rank = ids.findIndex((id) => expected.has(id));
    if (rank === 0) hitAt1 += 1;
    if (rank >= 0 && rank < k) hitAt5 += 1;
    if (rank >= 0) reciprocal += 1 / (rank + 1);
  }
  return {
    queries,
    hitAt1: queries === 0 ? 0 : hitAt1 / queries,
    hitAt5: queries === 0 ? 0 : hitAt5 / queries,
    mrr: queries === 0 ? 0 : reciprocal / queries,
  };
}

export interface RetentionSample {
  readonly expectedId: string;
  readonly recalled: readonly string[];
}

export interface InterferenceSample {
  readonly recalled: readonly string[];
  readonly distractors: readonly string[];
}

export function retentionRate(samples: readonly RetentionSample[]): number {
  if (samples.length === 0) return 0;
  let kept = 0;
  for (const sample of samples) if (sample.recalled.includes(sample.expectedId)) kept += 1;
  return kept / samples.length;
}

export function interferenceRate(samples: readonly InterferenceSample[]): number {
  if (samples.length === 0) return 0;
  let contaminated = 0;
  for (const sample of samples) {
    const distractors = new Set(sample.distractors);
    if (sample.recalled.some((id) => distractors.has(id))) contaminated += 1;
  }
  return contaminated / samples.length;
}

export function collectCostMs(startedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - startedAt);
}

export function collectCalibration(
  samples: readonly CalibrationSample[],
  buckets = 5,
): readonly CalibrationBucket[] {
  return calibrate(samples, buckets);
}

export function formatEvaluation(evaluation: RecallEvaluation): string {
  return [
    `queries: ${String(evaluation.queries)}`,
    `hit@1: ${evaluation.hitAt1.toFixed(3)}`,
    `hit@5: ${evaluation.hitAt5.toFixed(3)}`,
    `mrr:   ${evaluation.mrr.toFixed(3)}`,
  ].join('  ');
}
