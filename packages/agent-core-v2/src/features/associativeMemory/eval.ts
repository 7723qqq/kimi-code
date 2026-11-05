export interface RecallEvaluation {
  readonly queries: number;
  readonly hitAt1: number;
  readonly hitAt5: number;
  readonly mrr: number;
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

export function formatEvaluation(evaluation: RecallEvaluation): string {
  return [
    `queries: ${String(evaluation.queries)}`,
    `hit@1: ${evaluation.hitAt1.toFixed(3)}`,
    `hit@5: ${evaluation.hitAt5.toFixed(3)}`,
    `mrr:   ${evaluation.mrr.toFixed(3)}`,
  ].join('  ');
}
