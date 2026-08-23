import { getLocale } from '#/i18n';
import type { ToolbarTip } from '#/tui/constant/tips';

/** Toolbar / working tips advance to the next slot every 10 seconds. */
export const TIP_ROTATE_INTERVAL_MS = 10_000;

/**
 * Expand tips into a rotation sequence using smooth weighted round-robin
 * (the nginx SWRR algorithm). Higher-`priority` tips appear more often while
 * staying evenly spread, so a tip generally does not land next to its own
 * duplicate. Deterministic for a given input.
 */
export function buildWeightedTips(tips: readonly ToolbarTip[]): readonly ToolbarTip[] {
  const items = tips.map((t) => ({
    tip: t,
    weight: Math.max(1, Math.trunc(t.priority ?? 1)),
    current: 0,
  }));
  const total = items.reduce((sum, it) => sum + it.weight, 0);
  const seq: ToolbarTip[] = [];
  for (let n = 0; n < total; n++) {
    let best = items[0]!;
    for (const it of items) {
      it.current += it.weight;
      if (it.current > best.current) best = it;
    }
    best.current -= total;
    seq.push(best.tip);
  }
  return seq;
}

/**
 * Build a getter returning the weighted rotation for `getTips()`, rebuilt
 * only when the active locale changes so tip text follows the language
 * instead of freezing at module load. Each getter memoizes independently.
 */
export function createLocaleKeyedTipRotation(
  getTips: () => readonly ToolbarTip[],
): () => readonly ToolbarTip[] {
  let cache: { locale: string; rotation: readonly ToolbarTip[] } | null = null;
  return () => {
    const locale = getLocale();
    if (cache === null || cache.locale !== locale) {
      cache = { locale, rotation: buildWeightedTips(getTips()) };
    }
    return cache.rotation;
  };
}
