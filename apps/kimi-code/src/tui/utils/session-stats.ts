/**
 * Session-level stats accumulated from the session event stream and rendered
 * on the footer's second line (e.g. `4 turns · 8 steps | LLM 3m6s · tools 0.9s`).
 *
 * The accumulation helpers are pure — they take a `SessionStats` and return a
 * new object — so the TUI host only needs to store the latest value on
 * `AppState.sessionStats`. Rendering lives here too (kept free of UI state) so
 * both the accumulator and the width-adaptive segment dropping are unit-testable.
 */

import type { TokenUsage } from '@moonshot-ai/kimi-code-sdk';

import type { SessionStats } from '#/tui/types';

/** One renderable stat item. `priority` is the drop order when the footer
 *  is too narrow: lower = dropped first. `Infinity` = never dropped on its
 *  own (cache hit / context readout). */
export interface SessionStatsSegment {
  readonly text: string;
  readonly priority: number;
}

/** A visual group: items joined with ` · `, groups joined with ` | `.
 *  Items drop individually by priority; an empty group disappears. */
export interface SessionStatsGroup {
  readonly items: readonly SessionStatsSegment[];
}

export function createEmptySessionStats(): SessionStats {
  return {
    turnCount: 0,
    stepCount: 0,
    llmTotalMs: 0,
    toolTotalMs: 0,
    firstTokenSamples: [],
    inputTokens: 0,
    outputTokens: 0,
  };
}

export function bumpTurnCount(stats: SessionStats): SessionStats {
  return { ...stats, turnCount: stats.turnCount + 1 };
}

export function accumulateToolDuration(stats: SessionStats, ms: number): SessionStats {
  return { ...stats, toolTotalMs: stats.toolTotalMs + Math.max(0, ms) };
}

/** Fold one `turn.step.completed` event into the stats (step count, LLM stream
 *  time, first-token latency sample, exact input/output tokens). Undefined
 *  usage/timing fields are skipped, so providers that report partial data
 *  still produce consistent counters. */
export function accumulateStepCompleted(
  stats: SessionStats,
  usage: TokenUsage | undefined,
  llmStreamDurationMs: number | undefined,
  llmFirstTokenLatencyMs: number | undefined,
): SessionStats {
  const next: SessionStats = {
    ...stats,
    stepCount: stats.stepCount + 1,
  };
  if (
    typeof llmStreamDurationMs === 'number' &&
    Number.isFinite(llmStreamDurationMs) &&
    llmStreamDurationMs >= 0
  ) {
    next.llmTotalMs += llmStreamDurationMs;
  }
  if (
    typeof llmFirstTokenLatencyMs === 'number' &&
    Number.isFinite(llmFirstTokenLatencyMs) &&
    llmFirstTokenLatencyMs >= 0
  ) {
    next.firstTokenSamples = [...stats.firstTokenSamples, llmFirstTokenLatencyMs];
  }
  if (usage !== undefined) {
    next.inputTokens +=
      (usage.inputOther ?? 0) + (usage.inputCacheRead ?? 0) + (usage.inputCacheCreation ?? 0);
    next.outputTokens += usage.output ?? 0;
  }
  return next;
}

export function firstTokenAverageMs(stats: SessionStats): number | null {
  if (stats.firstTokenSamples.length === 0) return null;
  const sum = stats.firstTokenSamples.reduce((acc, s) => acc + s, 0);
  return sum / stats.firstTokenSamples.length;
}

/**
 * Stat duration in the footer's compact style: sub-minute values keep one
 * decimal (`0.9s`, `1.8s`), minutes show `3m6s` (seconds part omitted when 0),
 * hours show `1h2m`. Non-finite / negative input renders `0s`.
 */
export function formatStatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = ms / 1000;
  const rounded = Math.round(totalSeconds * 10) / 10;
  if (rounded < 60) return `${formatOneDecimal(rounded)}s`;
  let wholeMinutes = Math.floor(totalSeconds / 60);
  let remSeconds = Math.round(totalSeconds - wholeMinutes * 60);
  if (remSeconds >= 60) {
    wholeMinutes += 1;
    remSeconds -= 60;
  }
  if (wholeMinutes < 60) {
    return remSeconds > 0 ? `${wholeMinutes}m${remSeconds}s` : `${wholeMinutes}m`;
  }
  const hours = Math.floor(wholeMinutes / 60);
  return `${hours}h${wholeMinutes % 60}m`;
}

/**
 * One decimal place, dropping a redundant ".0" ("1.0" → "1", "1.5" stays).
 */
export function formatOneDecimal(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/**
 * Compose the footer's right-hand readout from ordered stat groups. Items
 * within a group join with ` · `, groups join with ` | `. When the combined
 * text would exceed `maxWidth`, the lowest-priority item is dropped and the
 * join is retried until it fits (empty groups disappear). Cache hit and
 * context carry `Infinity` priority, so a bare `context 43%` readout always
 * survives; if even that overflows it is returned as-is and the caller's
 * render truncation takes over.
 */
export function fitSessionStatsText(
  groups: readonly SessionStatsGroup[],
  maxWidth: number,
): string {
  if (groups.length === 0) return '';
  let pending = groups.map((g) => ({ items: [...g.items] }));
  let text = joinGroups(pending);
  while (visibleTextWidth(text) > maxWidth) {
    const droppable = pending
      .flatMap((group, groupIndex) =>
        group.items
          .filter((item) => Number.isFinite(item.priority))
          .map((item) => ({ item, groupIndex })),
      )
      .toSorted((a, b) => a.item.priority - b.item.priority);
    const toDrop = droppable[0];
    if (toDrop === undefined) {
      // Only Infinity items remain and they still don't fit — keep them all;
      // render() truncates the final line.
      return text;
    }
    pending = pending
      .map((group, groupIndex) =>
        groupIndex === toDrop.groupIndex
          ? { items: group.items.filter((item) => item !== toDrop.item) }
          : group,
      )
      .filter((group) => group.items.length > 0);
    if (pending.length === 0) return '';
    text = joinGroups(pending);
  }
  return text;
}

function joinGroups(groups: readonly { items: readonly SessionStatsSegment[] }[]): string {
  return groups.map((group) => group.items.map((item) => item.text).join(' · ')).join(' | ');
}

/** Visible (ANSI-stripped) width — mirrors the footer's own width helpers. */
function visibleTextWidth(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '').length;
}
