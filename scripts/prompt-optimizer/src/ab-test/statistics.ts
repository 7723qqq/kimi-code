/**
 * Prompt Optimizer — statistics for A/B comparisons.
 *
 * Both variants run against the SAME benchmark cases, so the results are paired:
 * a hard case is hard for both, and the interesting signal is the per-case
 * difference. An unpaired test treats the two sets as independent draws, which
 * discards that structure and, at the case counts this tool uses, cannot detect
 * the effects it is looking for at all.
 */

export class PairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingError';
  }
}

export interface PairedInput {
  /** Scores for variant A, keyed by task id, in case order. */
  readonly a: ReadonlyMap<string, readonly number[]>;
  /** Scores for variant B, keyed by the same task ids. */
  readonly b: ReadonlyMap<string, readonly number[]>;
}

/**
 * Per-case differences `B - A`, averaged over repetitions.
 *
 * Requires both sides to cover the same task ids: a missing case on one side
 * means the variants were not actually compared on equal footing.
 */
export function pairedDifferences(input: PairedInput): number[] {
  const idsA = [...input.a.keys()].toSorted();
  const idsB = [...input.b.keys()].toSorted();

  const onlyA = idsA.filter((id) => !input.b.has(id));
  const onlyB = idsB.filter((id) => !input.a.has(id));
  if (onlyA.length > 0 || onlyB.length > 0) {
    throw new PairingError(
      'variants were run on different case sets; cannot pair.\n' +
        `  only in A: ${onlyA.join(', ') || '(none)'}\n` +
        `  only in B: ${onlyB.join(', ') || '(none)'}`,
    );
  }

  return idsA.map((id) => mean(input.b.get(id) ?? []) - mean(input.a.get(id) ?? []));
}

/**
 * Paired sign-flip permutation test on the mean difference.
 *
 * Under the null the sign of each case's difference is exchangeable, so
 * resampling signs approximates the null distribution while keeping the
 * per-case magnitudes — which is what makes it sensitive to a consistent shift.
 *
 * @returns the two-sided p-value, or 1 when there is nothing to test
 */
export function pairedPermutationP(
  differences: readonly number[],
  iterations = 10_000,
  random: () => number = Math.random,
): number {
  if (differences.length === 0) return 1;

  const observed = Math.abs(mean(differences));
  if (observed < 1e-12) return 1;

  let atLeastAsExtreme = 0;
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (const d of differences) total += random() < 0.5 ? d : -d;
    if (Math.abs(total / differences.length) >= observed) atLeastAsExtreme += 1;
  }

  // +1 keeps the estimate from reporting p = 0 for a finite number of draws.
  return (atLeastAsExtreme + 1) / (iterations + 1);
}

export interface PowerEstimate {
  /** Cases per variant actually available. */
  readonly n: number;
  /** The smallest mean difference this n could distinguish from zero. */
  readonly detectableDelta: number;
  readonly sigma: number;
  readonly alpha: number;
}

/** Two-sided t quantiles at the conventional 0.05 level and 80% power. */
const T_ALPHA_2 = 1.96;
const T_BETA = 0.84;

/**
 * The effect size this sample could detect.
 *
 * Reporting it alongside the verdict is what separates "no difference" from
 * "not enough cases to see a difference" — a distinction a bare
 * significant/not-significant line cannot express.
 *
 * Uses the paired standard deviation when differences are supplied, since that
 * is the variance the test actually works against.
 */
export function estimatePower(
  values: readonly number[],
  differences: readonly number[] | undefined,
  alpha = 0.05,
): PowerEstimate {
  const n = values.length;
  const spread = differences !== undefined && differences.length > 1 ? differences : values;
  const sigma = standardDeviation(spread);
  if (n === 0) return { n: 0, detectableDelta: Number.POSITIVE_INFINITY, sigma, alpha };
  return {
    n,
    detectableDelta: (T_ALPHA_2 + T_BETA) * sigma * Math.sqrt(2 / n),
    sigma,
    alpha,
  };
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mu = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - mu) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}
