/**
 * TUI2 goal message formatting helpers.
 *
 * Mirrors `tui/components/messages/goal-format.ts`. Pure formatting — no
 * rendering, no pi-tui dependency. Kept as a `.ts` module (no `.tsx`
 * needed); the two functions are framework-free and reused verbatim by
 * the tui2 goal markers / goal panel.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import { t } from '#/i18n';

/** Format an elapsed duration (`ms`) as `3s` / `2m 05s` / `1h 02m`. */
export function formatGoalElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60)
    return t('tui.messages.goalFormat.elapsedSeconds', { count: totalSeconds });
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return t('tui.messages.goalFormat.elapsedMinutes', {
      minutes,
      seconds: seconds.toString().padStart(2, '0'),
    });
  }
  const hours = Math.floor(minutes / 60);
  return t('tui.messages.goalFormat.elapsedHours', {
    hours,
    minutes: (minutes % 60).toString().padStart(2, '0'),
  });
}

/** `N <singular|plural>` — plural defaults to `${singular}s`. */
export function pluralizeGoalCount(n: number, singular: string, plural?: string): string {
  return `${String(n)} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}
