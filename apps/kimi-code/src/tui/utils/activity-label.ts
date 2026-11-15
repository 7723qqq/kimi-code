import { getLocale, t } from '#/i18n';
import { formatDuration } from '#/tui/utils/transcript-items';
import type { Instant, TurnFacts } from '#/tui/utils/turn-timeline';

export function workingLabel(turn: TurnFacts | undefined, now: Instant): string {
  return turn?.kind === 'live'
    ? t('tui.chrome.activityPane.workingFor', { duration: formatDuration(now - turn.start) })
    : t('tui.chrome.activityPane.working');
}

export function workedSummary(turn: TurnFacts | undefined): string {
  if (turn?.kind !== 'ended' || turn.outcome !== 'completed') return '';
  return t('tui.chrome.activityPane.workedFor', {
    duration: formatDuration(turn.end - turn.start),
    time: clockTime(turn.endedAtMs),
  });
}

function clockTime(ms: number): string {
  const zh = getLocale() === 'zh';
  return new Date(ms).toLocaleTimeString(zh ? 'zh-CN' : 'en-US', {
    hour: zh ? '2-digit' : 'numeric',
    minute: '2-digit',
    hour12: !zh,
  });
}
