import { formatDuration } from '#/tui/utils/transcript-items';
import type { Instant, TurnFacts } from '#/tui/utils/turn-timeline';
import { t } from '#/i18n';

export function workingLabel(turn: TurnFacts | undefined, now: Instant): string {
  return turn?.kind === 'live' ? t('tui.chrome.activityPane.workingFor', { duration: formatDuration(now - turn.start) }) : t('tui.chrome.activityPane.working');
}

export function workedSummary(turn: TurnFacts | undefined): string {
  if (turn?.kind !== 'ended' || turn.outcome !== 'completed') return '';
  const doneAt = new Date(turn.endedAtMs).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return t('tui.chrome.activityPane.workedFor', { duration: formatDuration(turn.end - turn.start), time: doneAt });
}
