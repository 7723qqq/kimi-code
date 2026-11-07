export function rankByNeedGain<T>(
  items: readonly T[],
  needOf: (item: T) => number,
  gainOf: (item: T) => number,
  tie: (left: T, right: T) => number,
): readonly T[] {
  return [...items]
    .map((item) => ({ item, score: needOf(item) * gainOf(item) }))
    .toSorted((left, right) => right.score - left.score || tie(left.item, right.item))
    .map((entry) => entry.item);
}

export function interleave<T>(ranked: readonly T[], limit: number, strata: number): readonly T[] {
  if (ranked.length === 0 || limit <= 0 || strata <= 0) return [];
  const tiers: T[][] = Array.from({ length: strata }, () => []);
  ranked.forEach((item, index) => {
    const tier = Math.min(strata - 1, Math.floor((index * strata) / ranked.length));
    tiers[tier]!.push(item);
  });
  const out: T[] = [];
  let cursor = 0;
  while (out.length < Math.min(limit, ranked.length)) {
    const tier = tiers[cursor % strata]!;
    const item = tier.shift();
    if (item !== undefined) out.push(item);
    cursor += 1;
    if (tiers.every((candidate) => candidate.length === 0)) break;
  }
  return out;
}
