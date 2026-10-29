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

import { t } from '#/i18n';
import type { SessionStats } from '#/tui/types';
import { formatTokenCount, usagePercent, usagePercentFromRatio } from '#/utils/usage/usage-format';

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
 * Footer speed readout: one decimal below 100 tok/s ("49.3"), integer at and
 * above ("4957") — a trailing decimal on a four-digit rate is false
 * precision. Non-finite / non-positive input renders "0".
 *
 * The web status panel formats the same unit differently (one decimal below
 * 10, integer above) because it rounds a mid-range reading more finely than a
 * footer that has to survive a narrow pane. Both report the same quantity — the
 * session-cumulative tokens-per-second rate — and differ only in these rounding
 * thresholds.
 */
export function formatTokenSpeed(speed: number): string {
  if (!Number.isFinite(speed) || speed <= 0) return '0';
  return speed >= 100 ? String(Math.round(speed)) : formatOneDecimal(speed);
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

export function buildSessionStatSegments(
  stats: SessionStats,
  hitRateText: string | null,
  speedStepText: string | null,
  speedAverageText: string | null,
  contextText: string,
): SessionStatsGroup[] {
  const groups: SessionStatsGroup[] = [];
  if (stats.turnCount > 0 || stats.stepCount > 0) {
    const turnText = t(
      stats.turnCount === 1 ? 'tui.chrome.footer.turn_one' : 'tui.chrome.footer.turn_other',
      { count: String(stats.turnCount) },
    );
    const stepText = t(
      stats.stepCount === 1 ? 'tui.chrome.footer.step_one' : 'tui.chrome.footer.step_other',
      { count: String(stats.stepCount) },
    );
    groups.push({
      items: [
        {
          text: t('tui.chrome.footer.turnsSteps', { turns: turnText, steps: stepText }),
          priority: 1,
        },
      ],
    });
  }
  const llmTool: SessionStatsSegment[] = [];
  if (stats.llmTotalMs > 0) {
    llmTool.push({
      text: t('tui.chrome.footer.llmTime', { time: formatStatDuration(stats.llmTotalMs) }),
      priority: 2,
    });
  }
  if (stats.toolTotalMs > 0) {
    llmTool.push({
      text: t('tui.chrome.footer.toolTime', { time: formatStatDuration(stats.toolTotalMs) }),
      priority: 2,
    });
  }
  if (llmTool.length > 0) groups.push({ items: llmTool });

  const latencySpeed: SessionStatsSegment[] = [];
  const firstToken = firstTokenAverageMs(stats);
  if (firstToken !== null) {
    latencySpeed.push({
      text: t('tui.chrome.footer.firstTokenAvg', { time: formatStatDuration(firstToken) }),
      priority: 4,
    });
  }
  // The two rates share one drop slot: they are only meaningful read together,
  // and dropping one would leave the survivor looking like the only answer. So
  // they are emitted as a single segment — `fitSessionStatsText` drops items,
  // not halves of one, and two items at the same priority would be dropped one
  // at a time and split the pair.
  const speedText = [speedStepText, speedAverageText].filter((s) => s !== null);
  if (speedText.length > 0) {
    latencySpeed.push({ text: speedText.join(' · '), priority: 5 });
  }
  if (latencySpeed.length > 0) groups.push({ items: latencySpeed });

  if (hitRateText !== null) {
    groups.push({ items: [{ text: hitRateText, priority: Number.POSITIVE_INFINITY }] });
  }
  if (stats.inputTokens > 0 || stats.outputTokens > 0) {
    groups.push({
      items: [
        {
          text: t('tui.chrome.footer.inputOutput', {
            input: formatTokenCount(stats.inputTokens),
            output: formatTokenCount(stats.outputTokens),
          }),
          priority: 2,
        },
      ],
    });
  }
  groups.push({ items: [{ text: contextText, priority: Number.POSITIVE_INFINITY }] });
  return groups;
}

export function formatContextStatus(usage: number, tokens?: number, maxTokens?: number): string {
  if (maxTokens !== undefined && maxTokens > 0 && tokens !== undefined) {
    const pct = String(usagePercent(tokens, maxTokens));
    return t('tui.chrome.footer.contextWithTokens', {
      pct,
      tokens: formatTokenCount(tokens),
      maxTokens: formatTokenCount(maxTokens),
    });
  }
  return t('tui.chrome.footer.context', { pct: String(usagePercentFromRatio(usage)) });
}

/**
 * Live cache hit rate readout, e.g. `cache hit 87%`. Hidden until at least one
 * step reported usage (no session traffic yet).
 *
 * Hit rate: reads / (reads + writes) when the provider reports cache writes.
 * OpenAI-compatible endpoints (Kimi/DeepSeek/OpenAI) never surface cache
 * writes — their miss lands in `input_other` — so the share-of-total-input
 * fallback is the norm for them, otherwise the readout would always read 100%.
 */
export function formatCacheHitRate(
  cacheReadTokens: number,
  cacheMissTokens: number,
  cacheOtherTokens: number,
): string | null {
  const read = cacheReadTokens ?? 0;
  const miss = cacheMissTokens ?? 0;
  const other = cacheOtherTokens ?? 0;
  let pct: number;
  if (miss > 0) {
    pct = Math.round((read / (read + miss)) * 100);
  } else if (read > 0) {
    const inputTotal = read + other;
    pct = inputTotal > 0 ? Math.round((read / inputTotal) * 100) : 0;
  } else {
    return null;
  }
  return t('tui.chrome.footer.cacheHit', { pct: String(pct) });
}

/**
 * Compose the footer's right-hand readout as ordered groups (items in a group
 * join with ` · `, groups with ` | `). Display order: turns/steps, LLM time ·
 * tool time, first-token avg · tok/s, cache hit, input/output, context. The
 * cache-hit and context readouts carry `Infinity` priority and only disappear
 * when their data is absent entirely.
 *
 * Item drop priority (lower = dropped first when the terminal narrows):
 * turn/step counters (1) → tools time (2) → LLM time (2) → input/output (2) →
 * first-token avg (4) → tok/s (5), with cache hit and context never dropped.
 *
 * The rule behind that order: information a later render cannot reconstruct
 * outranks information that is merely decorative, and live information outranks
 * both. The counters and the cumulative timings are session totals that keep
 * growing on screen whether or not they are shown right now, so they go first.
 * First-token latency describes the reply that already started, which the
 * phase indicator has already carried the user through. `tok/s` is the one item
 * that keeps moving as the session continues — it is what the user watches
 * while a reply streams — so it is the last optional item to go. A narrow pane
 * that keeps `context` and a stale token total while dropping the rates has kept
 * the decorations and lost the measurement. The step rate and the session
 * average share one slot and one priority: they only mean anything side by side,
 * and either alone reads like the whole answer. Neither is instantaneous — the
 * step rate is the step that just closed; see `utils/token-speed.ts`.
 */
