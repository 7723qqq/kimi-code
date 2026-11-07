export interface CalibrationBucket {
  readonly bucket: number;
  readonly predicted: number;
  readonly observed: number;
  readonly count: number;
}

export interface CalibrationSample {
  readonly confidence: number;
  readonly confirmed: boolean;
}

export function updateConfidence(current: number, confirmed: boolean, rate: number): number {
  const target = confirmed ? 1 : 0;
  return Math.max(0, Math.min(1, current + rate * (target - current)));
}

export function calibrate(
  samples: readonly CalibrationSample[],
  buckets = 5,
): readonly CalibrationBucket[] {
  const groups = Array.from({ length: buckets }, () => ({ predicted: 0, observed: 0, count: 0 }));
  for (const sample of samples) {
    const index = Math.min(buckets - 1, Math.max(0, Math.floor(sample.confidence * buckets)));
    const group = groups[index]!;
    group.predicted += sample.confidence;
    group.observed += sample.confirmed ? 1 : 0;
    group.count += 1;
  }
  return groups.map((group, bucket) => ({
    bucket,
    predicted: group.count === 0 ? 0 : group.predicted / group.count,
    observed: group.count === 0 ? 0 : group.observed / group.count,
    count: group.count,
  }));
}
