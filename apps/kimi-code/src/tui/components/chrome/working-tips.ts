import { getWorkingTips, type ToolbarTip } from '#/tui/constant/tips';
import { createLocaleKeyedTipRotation, TIP_ROTATE_INTERVAL_MS } from '#/tui/utils/tip-rotation';

export { getWorkingTips };

const getWorkingTipRotation = createLocaleKeyedTipRotation(getWorkingTips);

export function currentWorkingTip(now = Date.now()): ToolbarTip | undefined {
  const rotation = getWorkingTipRotation();
  if (rotation.length === 0) return undefined;
  const index = Math.floor(now / TIP_ROTATE_INTERVAL_MS) % rotation.length;
  return rotation[index];
}

/**
 * Pick a random tip from the weighted working-tip rotation.
 * If `excludeText` is provided and there are other tips available, avoid
 * returning the same text twice in a row.
 */
export function pickRandomWorkingTip(excludeText?: string): ToolbarTip | undefined {
  const rotation = getWorkingTipRotation();
  if (rotation.length === 0) return undefined;
  const candidates =
    excludeText === undefined || rotation.length === 1
      ? rotation
      : rotation.filter((tip) => tip.text !== excludeText);
  const pool = candidates.length > 0 ? candidates : rotation;
  const index = Math.floor(Math.random() * pool.length);
  return pool[index];
}
