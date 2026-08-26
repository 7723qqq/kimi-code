/** @jsxImportSource @opentui/solid */
/**
 * TUI2 footer/status bar — multi-line status display at the bottom of the TUI.
 *
 * Replaces `tui/components/chrome/footer.ts`'s `FooterComponent` (a pi-tui
 * `Component` with imperative `setState` / `setTransientHint` /
 * `setBackgroundCounts` and its own goal/pulse timers) with an opentui
 * SolidJS view driven entirely by the response store:
 *
 *   Line 1: slots from status_line.items (mode, goal, model, tasks, cwd, git)
 *           joined left, rotating tips right (unless 'tips' is a slot); a
 *           status_line.command's first stdout line replaces it when set.
 *   Line 2: transient hint left, session stats right (turns/steps, LLM · tool
 *           time, first-token avg · tok/s, cache hit, in/out tokens, context).
 *
 * Timers are SolidJS effects: a 1s clock while a goal is active (elapsed
 * badge), an 80ms pulse while thinking (model label shimmer), a 1s status
 * line command refresh, and a git-status cache recreated on workDir change.
 * The pure formatting helpers (`buildWeightedTips`, `formatGoalBadge`,
 * `formatContextStatus`, `formatCacheHitRate`, `buildSessionStatSegments`,
 * `fitSessionStatsText`) are kept verbatim from v1.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component, JSX } from 'solid-js'
import { createEffect, createSignal, onCleanup } from 'solid-js'
import { effectiveModelAlias, type GoalSnapshot } from '@moonshot-ai/kimi-code-sdk'
import { useTerminalDimensions } from '@opentui/solid'
import type { ColorInput } from '@opentui/core'

import { getLocale, t } from '#/i18n'
import { getAllTips, type ToolbarTip } from '../../constant/tips'
import {
  getDanceRainbowPalette,
  getRainbowDanceView,
  isRainbowDancing,
} from '../../easter-eggs/dance'
import { useTui2Store, type TuiRuntimeState } from '../../state'
import { currentTheme } from '../../theme'
import type { SessionStats } from '../../types'
import {
  firstTokenAverageMs,
  fitSessionStatsText,
  formatOneDecimal,
  formatStatDuration,
  type SessionStatsGroup,
  type SessionStatsSegment,
} from '../../utils/session-stats'
import {
  STATUS_LINE_RERUN_INTERVAL_MS,
  StatusLineCommandRunner,
  type StatusLinePayload,
} from '../../utils/status-line-command'
import {
  createGitStatusCache,
  formatGitBadgeBase,
  formatPullRequestBadge,
  type GitStatus,
  type GitStatusCache,
} from '#/utils/git/git-status'
import { formatTokenCount, usagePercent, usagePercentFromRatio } from '#/utils/usage/usage-format'

import { Box } from '../common/box'
import { Clickable } from '../common/clickable'
import { Text } from '../common/text'

export interface FooterViewProps {
  /** Fired when the model slot is clicked (host opens the model selector). */
  readonly onModelClick?: () => void
  /** Fired when the mode/permission slot is clicked. */
  readonly onModeClick?: () => void
  /** Fired when the background tasks slot is clicked. */
  readonly onTasksClick?: () => void
  /** Fired when the goal slot is clicked. */
  readonly onGoalClick?: () => void
}

const DEFAULT_STATUS_LINE_ITEMS = ['mode', 'goal', 'model', 'tasks', 'cwd', 'git'] as const;

const MAX_CWD_SEGMENTS = 3;
const GOAL_TIMER_INTERVAL_MS = 1_000;
const THINKING_PULSE_INTERVAL_MS = 80;

// Toolbar tips — rotates every 10s. Most tips are short and pair up (two
// joined by " | ") when space allows; tips flagged `solo` are long or
// important enough to take the whole slot on their own. A `priority` weight
// makes a tip recur more often in the rotation (default 1). Width is always
// the final arbiter (a pair that doesn't fit falls back to its first tip).
const TIP_ROTATE_INTERVAL_MS = 10_000;
const TIP_SEPARATOR = ' | ';

/**
 * Expand tips into a rotation sequence using smooth weighted round-robin
 * (the nginx SWRR algorithm). Higher-`priority` tips appear more often while
 * staying evenly spread, so a tip generally does not land next to its own
 * duplicate. Deterministic for a given input; the footer memoizes the result
 * per locale (see getRotation). Exported for unit testing.
 */
export function buildWeightedTips(tips: readonly ToolbarTip[]): readonly ToolbarTip[] {
  const items = tips.map((tip) => ({
    tip,
    weight: Math.max(1, Math.trunc(tip.priority ?? 1)),
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

// Weighted rotation is rebuilt only when the locale changes, so tip text
// follows the active language instead of freezing at module load.
let rotationCache: { locale: string; rotation: readonly ToolbarTip[] } | null = null;
function getRotation(): readonly ToolbarTip[] {
  const locale = getLocale();
  if (rotationCache === null || rotationCache.locale !== locale) {
    rotationCache = { locale, rotation: buildWeightedTips(getAllTips()) };
  }
  return rotationCache.rotation;
}

function currentTipIndex(): number {
  return Math.floor(Date.now() / TIP_ROTATE_INTERVAL_MS);
}

/**
 * Pick the tip(s) for a rotation index over the weighted ROTATION sequence.
 * `primary` is always shown when it fits; `pair` (primary + next tip joined
 * by the separator) is offered for wide terminals. Pairing is skipped when
 * the current/next tip is `solo` or when the neighbour is a duplicate of the
 * current tip (which can happen at the wrap boundary), keeping long/important
 * tips on their own and avoiding "X | X".
 */
function tipsForIndex(index: number): { primary: string; pair: string | null } {
  const rotation = getRotation();
  const n = rotation.length;
  if (n === 0) return { primary: '', pair: null };
  const offset = ((index % n) + n) % n;
  const current = rotation[offset]!;
  if (n === 1 || current.solo) return { primary: current.text, pair: null };
  const next = rotation[(offset + 1) % n]!;
  if (next.solo || next.text === current.text) return { primary: current.text, pair: null };
  return { primary: current.text, pair: current.text + TIP_SEPARATOR + next.text };
}

/**
 * Footer goal badge, e.g. `[goal ● active · 4m · 7 turns]`. Only shown for a
 * live (active/paused/blocked) goal; terminal/no goal -> no badge. Turn count
 * is a raw count unless an explicit turn budget is set, in which case it
 * shows used/limit. Returns the dot color + label; the view composes the
 * bracketed badge so the dot keeps its own color.
 */
function formatGoalBadge(goal: GoalSnapshot, wallClockMs?: number): { dotColor: ColorInput; label: string } | null {
  // Show the badge for every persisted, resumable status. `complete` clears the
  // goal, so it never reaches here; only the unset case returns null.
  if (goal.status !== 'active' && goal.status !== 'paused' && goal.status !== 'blocked') {
    return null;
  }
  const dotColor =
    goal.status === 'active'
      ? currentTheme.color('primary')
      : goal.status === 'blocked'
        ? currentTheme.color('warning')
        : currentTheme.color('textMuted');
  const turns =
    goal.budget.turnBudget !== null
      ? `${goal.turnsUsed}/${goal.budget.turnBudget} ${t('tui.chrome.footer.turns')}`
      : goal.turnsUsed === 1
        ? t('tui.chrome.footer.turn_one', { count: String(goal.turnsUsed) })
        : t('tui.chrome.footer.turn_other', { count: String(goal.turnsUsed) });
  const statusLabel =
    goal.status === 'active'
      ? t('tui.chrome.footer.statusActive')
      : goal.status === 'blocked'
        ? t('tui.chrome.footer.statusBlocked')
        : t('tui.chrome.footer.statusPaused');
  const label = `${statusLabel} · ${formatBadgeElapsed(wallClockMs ?? goal.wallClockMs)} · ${turns}`;
  return { dotColor, label };
}

function formatBadgeElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function modelDisplayName(state: TuiRuntimeState): string {
  const model = state.availableModels[state.model];
  const effective = model === undefined ? undefined : effectiveModelAlias(model);
  return effective?.displayName ?? effective?.model ?? state.model;
}

function shortenCwd(path: string): string {
  if (!path) return path;
  const home = process.env['HOME'] ?? '';
  let work = path;
  if (home && path === home) {
    return '~';
  }
  if (home && path.startsWith(home + '/')) {
    work = '~' + path.slice(home.length);
  }

  const segments = work.split('/').filter((s) => s.length > 0);
  if (segments.length <= MAX_CWD_SEGMENTS) return work;
  const tail = segments.slice(-MAX_CWD_SEGMENTS).join('/');
  return `…/${tail}`;
}

/**
 * Footer context readout. Percent comes from the exact token counts when
 * both are known (the ratio can lag a step behind); otherwise it falls
 * back to the precomputed ratio. Counts use the shared 1024-based
 * formatter.
 */
function formatContextStatus(usage: number, tokens?: number, maxTokens?: number): string {
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
function formatCacheHitRate(
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
 * when their data is absent entirely. Item drop priority (lower = dropped
 * first when the terminal narrows): tool time → first-token avg → tok/s →
 * LLM time → input/output → turns/steps.
 */
function buildSessionStatSegments(
  stats: SessionStats,
  hitRateText: string | null,
  speedText: string | null,
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
          priority: 6,
        },
      ],
    });
  }
  const llmTool: SessionStatsSegment[] = [];
  if (stats.llmTotalMs > 0) {
    llmTool.push({
      text: t('tui.chrome.footer.llmTime', { time: formatStatDuration(stats.llmTotalMs) }),
      priority: 4,
    });
  }
  if (stats.toolTotalMs > 0) {
    llmTool.push({
      text: t('tui.chrome.footer.toolTime', { time: formatStatDuration(stats.toolTotalMs) }),
      priority: 1,
    });
  }
  if (llmTool.length > 0) groups.push({ items: llmTool });

  const latencySpeed: SessionStatsSegment[] = [];
  const firstToken = firstTokenAverageMs(stats);
  if (firstToken !== null) {
    latencySpeed.push({
      text: t('tui.chrome.footer.firstTokenAvg', { time: formatStatDuration(firstToken) }),
      priority: 2,
    });
  }
  if (speedText !== null) {
    latencySpeed.push({ text: speedText, priority: 3 });
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
          priority: 5,
        },
      ],
    });
  }
  groups.push({ items: [{ text: contextText, priority: Number.POSITIVE_INFINITY }] });
  return groups;
}

/**
 * Plain-text git badge for the footer: `branch [±]` in the dim shade plus an
 * optional `[PR#N]` chip. The v1 version returned chalk ANSI; the tui2 view
 * applies the palette itself, so this returns uncolored text.
 */
export function formatFooterGitBadge(status: GitStatus): string {
  const base = formatGitBadgeBase(status);
  if (status.pullRequest === null) return base;
  return `${base} ${formatPullRequestBadge(status.pullRequest, { linkPullRequest: false })}`;
}

/** One colored run of a status-line slot. */
interface SlotPiece {
  readonly text: string;
  readonly fg: ColorInput;
  readonly attributes?: number;
  /** Per-character rainbow (dance easter egg / swarm-plan badge). */
  readonly rainbow?: boolean;
  /** Bold rainbow text (swarm-plan badge). */
  readonly bold?: boolean;
}

/** Per-character rainbow text built from the shared dance palette. */
function RainbowText(props: { text: string; offset: number; bold?: boolean }) {
  const palette = getDanceRainbowPalette()
  let colorIndex = props.offset
  const spans = Array.from(props.text).map((char) => {
    if (char === ' ') return <Text>{char}</Text>
    const color = palette[colorIndex % palette.length] ?? palette[0]
    colorIndex++
    return (
      <Text fg={color} attributes={props.bold === true ? currentTheme.attributes('bold') : undefined}>
        {char}
      </Text>
    )
  })
  return <>{spans}</>
}

export const FooterView: Component<FooterViewProps> = (props) => {
  const store = useTui2Store()
  const dimensions = useTerminalDimensions()
  const [now, setNow] = createSignal(Date.now())
  const [pulsePhase, setPulsePhase] = createSignal(0)
  const [gitStatus, setGitStatus] = createSignal<GitStatus | null>(null)
  const [customLine, setCustomLine] = createSignal<string | null>(null)
  const [modelHovered, setModelHovered] = createSignal(false)
  const [goalObservedAt, setGoalObservedAt] = createSignal(Date.now())
  let lastGoalKey: string | null = null

  // ── git status cache, recreated when workDir changes ──
  let gitCache: GitStatusCache | null = null
  const refreshGit = (): void => {
    if (gitCache !== null) setGitStatus(gitCache.getStatus());
  };
  createEffect(() => {
    const workDir = store.state.workDir;
    gitCache = createGitStatusCache(workDir, { onChange: refreshGit });
    refreshGit();
    onCleanup(() => {
      gitCache = null;
    });
  });

  // ── status_line.command runner: first stdout line replaces line 1 ──
  let runner: StatusLineCommandRunner | null = null
  const refreshCustomLine = (): void => {
    if (runner !== null) setCustomLine(runner.current());
  };
  createEffect(() => {
    const command = store.state.statusLine?.command ?? null;
    setCustomLine(null);
    if (command === null) return;
    runner = new StatusLineCommandRunner(command, refreshCustomLine);
    const timer = setInterval(() => {
      runner?.maybeRefresh(statusLinePayload());
    }, STATUS_LINE_RERUN_INTERVAL_MS);
    timer.unref?.();
    onCleanup(() => {
      clearInterval(timer);
      runner?.dispose();
      runner = null;
    });
  });

  // ── goal elapsed clock: 1s tick while a goal is active ──
  createEffect(() => {
    const goal = store.state.goal;
    const key = goalSnapshotKey(goal);
    if (key !== lastGoalKey) {
      lastGoalKey = key;
      setGoalObservedAt(Date.now());
    }
    if (goal?.status !== 'active') return;
    const timer = setInterval(() => setNow(Date.now()), GOAL_TIMER_INTERVAL_MS);
    timer.unref?.();
    onCleanup(() => clearInterval(timer));
  });

  // ── thinking pulse: 80ms shimmer while the model is thinking ──
  createEffect(() => {
    const thinking = store.state.thinkingEffort !== 'off' && store.state.streamingPhase !== 'idle';
    if (!thinking) {
      setPulsePhase(0);
      return;
    }
    const timer = setInterval(
      () => setPulsePhase((v) => (v + 0.05) % 1),
      THINKING_PULSE_INTERVAL_MS,
    );
    timer.unref?.();
    onCleanup(() => clearInterval(timer));
  });

  const statusLinePayload = (): StatusLinePayload => {
    const state = store.state;
    return {
      model: modelDisplayName(state),
      cwd: state.workDir,
      gitBranch: gitStatus()?.branch ?? null,
      permissionMode: state.permissionMode,
      planMode: state.planMode,
      contextUsage: state.contextUsage,
      contextTokens: state.contextTokens,
      maxContextTokens: state.maxContextTokens,
      sessionId: state.sessionId,
      version: state.version,
    };
  };

  const goalWallClockMs = (goal: GoalSnapshot): number => {
    if (goal.status !== 'active') return goal.wallClockMs;
    // `now()` is read here so the 1s goal clock actually repaints.
    return goal.wallClockMs + Math.max(0, now() - goalObservedAt());
  };

  const modelLabel = (): string => {
    const state = store.state;
    const model = modelDisplayName(state);
    const effort = state.thinkingEffort;
    const rawCurrentModel = state.availableModels[state.model];
    const currentModel = rawCurrentModel === undefined ? undefined : effectiveModelAlias(rawCurrentModel);
    // Only effort-capable models (those declaring support_efforts) show the
    // concrete effort; legacy boolean models keep the plain "thinking" suffix.
    const hasEfforts = (currentModel?.supportEfforts?.length ?? 0) > 0;
    const thinkingLabel =
      effort !== 'off'
        ? hasEfforts && effort !== 'on'
          ? t('tui.chrome.footer.thinkingEffort', { effort })
          : t('tui.chrome.footer.thinking')
        : '';
    return `${model}${thinkingLabel}`;
  };

  /** Non-hover model slot pieces: `[model thinking]` with a pulsing label. */
  const modelPieces = (): SlotPiece[] => {
    const state = store.state;
    const label = modelLabel();
    const thinkingLabel = label.slice(modelDisplayName(state).length);
    const thinkingColor =
      pulsePhase() > 0
        ? pulseHexColor(
            currentTheme.hex('textDim'),
            currentTheme.hex('text'),
            Math.sin(pulsePhase() * Math.PI),
          )
        : currentTheme.color('text');
    if (isRainbowDancing()) {
      return [{ text: label, fg: currentTheme.color('text'), rainbow: true }];
    }
    const pieces: SlotPiece[] = [
      { text: '[', fg: currentTheme.color('primary') },
      { text: modelDisplayName(state), fg: currentTheme.color('text') },
    ];
    if (thinkingLabel.length > 0) {
      pieces.push({ text: thinkingLabel, fg: thinkingColor });
    }
    pieces.push({ text: ']', fg: currentTheme.color('primary') });
    return pieces;
  };

  const buildSlots = (): Record<string, SlotPiece[]> => {
    const state = store.state;
    const slots: Record<string, SlotPiece[]> = {
      mode: [],
      goal: [],
      model: [],
      tasks: [],
      cwd: [],
      git: [],
      tips: [],
    };

    {
      const { primary, pair } = tipsForIndex(currentTipIndex());
      const tip = pair ?? primary;
      if (tip) slots['tips'] = [{ text: tip, fg: currentTheme.color('textMuted') }];
    }

    const modes: SlotPiece[] = [];
    if (state.permissionMode === 'auto')
      modes.push({
        text: t('tui.chrome.footer.auto'),
        fg: currentTheme.color('warning'),
        attributes: currentTheme.attributes('bold'),
      });
    if (state.permissionMode === 'yolo')
      modes.push({
        text: t('tui.chrome.footer.yolo'),
        fg: currentTheme.color('warning'),
        attributes: currentTheme.attributes('bold'),
      });
    if (state.planMode && state.swarmMode) {
      modes.push({
        text: t('tui.chrome.footer.swarmPlan'),
        fg: currentTheme.color('primary'),
        rainbow: true,
        bold: true,
      });
    } else {
      if (state.planMode)
        modes.push({
          text: t('tui.chrome.footer.plan'),
          fg: currentTheme.color('primary'),
          attributes: currentTheme.attributes('bold'),
        });
      if (state.swarmMode)
        modes.push({
          text: t('tui.chrome.footer.swarm'),
          fg: currentTheme.color('accent'),
          attributes: currentTheme.attributes('bold'),
        });
    }
    if (modes.length > 0) slots['mode'] = modes;

    const goal = state.goal;
    if (goal !== null && goal !== undefined) {
      const badge = formatGoalBadge(goal, goalWallClockMs(goal));
      if (badge !== null) {
        slots['goal'] = [
          { text: '[goal ', fg: currentTheme.color('textMuted') },
          { text: '\u25CF', fg: badge.dotColor },
          { text: ` ${badge.label}]`, fg: currentTheme.color('textMuted') },
        ];
      }
    }

    // Background-task badges. `bash-*` tasks (shell processes) and `agent-*`
    // tasks (background subagents) stay separate so the user can tell them
    // apart at a glance.
    const taskBadges: SlotPiece[] = [];
    if (state.backgroundCounts.bashTasks > 0) {
      const noun = t(
        state.backgroundCounts.bashTasks === 1
          ? 'tui.chrome.footer.task_one'
          : 'tui.chrome.footer.task_other',
        { count: String(state.backgroundCounts.bashTasks) },
      );
      taskBadges.push({ text: `[${noun}]`, fg: currentTheme.color('primary') });
    }
    if (state.backgroundCounts.agentTasks > 0) {
      const noun = t(
        state.backgroundCounts.agentTasks === 1
          ? 'tui.chrome.footer.agent_one'
          : 'tui.chrome.footer.agent_other',
        { count: String(state.backgroundCounts.agentTasks) },
      );
      taskBadges.push({ text: `[${noun}]`, fg: currentTheme.color('primary') });
    }
    slots['tasks'] = taskBadges;

    const cwd = shortenCwd(state.workDir);
    if (cwd) slots['cwd'] = [{ text: cwd, fg: currentTheme.color('textDim') }];

    const git = gitStatus();
    if (git !== null) {
      slots['git'] = [
        { text: formatGitBadgeBase(git), fg: currentTheme.color('textDim') },
        ...(git.pullRequest !== null
          ? [
              {
                text: ` ${formatPullRequestBadge(git.pullRequest, { linkPullRequest: false })}`,
                fg: currentTheme.color('primary'),
              },
            ]
          : []),
      ];
    }

    return slots;
  };

  const renderPiece = (piece: SlotPiece): JSX.Element => {
    if (piece.rainbow === true) {
      return (
        <RainbowText
          text={piece.text}
          offset={getRainbowDanceView()?.phase ?? 0}
          bold={piece.bold === true}
        />
      )
    }
    return (
      <Text fg={piece.fg} attributes={piece.attributes} wrapMode="none">
        {piece.text}
      </Text>
    )
  }

  const line1 = (): JSX.Element => {
    const custom = customLine();
    if (custom !== null) {
      return (
        <Text fg={currentTheme.color('text')} wrapMode="none" truncate>
          {custom}
        </Text>
      )
    }
    const slots = buildSlots();
    const configured = store.state.statusLine?.items ?? null;
    const order: readonly string[] = configured ?? DEFAULT_STATUS_LINE_ITEMS;
    const tipsInline = order.includes('tips');
    const showTips = !tipsInline && (configured === null || configured.includes('tips'));
    const { primary, pair } = tipsForIndex(currentTipIndex());
    const tip = showTips ? (pair ?? primary) : '';

    return (
      <Box flexDirection="row" gap={2} width="100%">
        {order.map((slot) => {
          if (slot === 'model' && modelDisplayName(store.state).length > 0) {
            return (
              <Clickable
                flexShrink={0}
                onClick={() => props.onModelClick?.()}
                onHover={({ hovered }) => setModelHovered(hovered)}
                hoverBackgroundColor={currentTheme.color('primary')}
              >
                <Box flexDirection="row" flexShrink={0}>
                  {modelHovered() ? (
                    <Text fg={currentTheme.color('text')} wrapMode="none" flexShrink={0}>
                      {`[ ${modelLabel()} ]`}
                    </Text>
                  ) : (
                    modelPieces().map((piece) => renderPiece(piece))
                  )}
                </Box>
              </Clickable>
            )
          }
          const pieces = slots[slot];
          if (pieces === undefined || pieces.length === 0) return null;
          const clickHandler =
            slot === 'mode'
              ? props.onModeClick
              : slot === 'tasks'
                ? props.onTasksClick
                : slot === 'goal'
                  ? props.onGoalClick
                  : undefined;
          if (clickHandler !== undefined) {
            return (
              <Clickable
                flexShrink={0}
                onClick={() => clickHandler()}
                hoverBackgroundColor={currentTheme.color('primary')}
              >
                <Box flexDirection="row" gap={1} flexShrink={0}>
                  {pieces.map((piece) => renderPiece(piece))}
                </Box>
              </Clickable>
            );
          }
          return (
            <Box flexDirection="row" gap={1} flexShrink={0}>
              {pieces.map((piece) => renderPiece(piece))}
            </Box>
          )
        })}
        <Box flexGrow={1} />
        {tip.length > 0 ? (
          <Text fg={currentTheme.color('textMuted')} wrapMode="none" truncate flexShrink={1}>
            {tip}
          </Text>
        ) : null}
      </Box>
    )
  }

  const line2 = (): JSX.Element => {
    const state = store.state;
    const hitRateText = formatCacheHitRate(
      state.cacheReadTokens,
      state.cacheMissTokens,
      state.cacheOtherTokens,
    );
    const speedText =
      (state.tokenSpeed ?? 0) > 0
        ? t('tui.chrome.footer.tokenSpeed', { speed: formatOneDecimal(state.tokenSpeed ?? 0) })
        : null;
    const contextText = formatContextStatus(
      state.contextUsage,
      state.contextTokens,
      state.maxContextTokens,
    );
    const segments = buildSessionStatSegments(
      state.sessionStats,
      hitRateText,
      speedText,
      contextText,
    );
    // The context group is always present; when nothing else exists there is
    // no session traffic yet — keep the old plain context readout instead of
    // a stats bar with a single group.
    const hasLiveStats = segments.length > 1;
    const rightText = hasLiveStats ? fitSessionStatsText(segments, dimensions().width) : contextText;
    const hint = state.footerTransientHint;

    return (
      <Box flexDirection="row">
        {hint !== null ? (
          <Text
            fg={currentTheme.color('warning')}
            attributes={currentTheme.attributes('bold')}
            wrapMode="none"
            truncate
            flexShrink={1}
          >
            {hint}
          </Text>
        ) : null}
        <Box flexGrow={1} />
        <Text fg={currentTheme.color('text')} wrapMode="none" truncate flexShrink={0}>
          {rightText}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {line1()}
      {line2()}
    </Box>
  )
}

function goalSnapshotKey(goal: GoalSnapshot | null | undefined): string | null {
  if (goal === null || goal === undefined) return null;
  return [
    goal.goalId,
    goal.status,
    goal.terminalReason ?? '',
    String(goal.turnsUsed),
    String(goal.tokensUsed),
    String(goal.wallClockMs),
    String(goal.budget.tokenBudget),
    String(goal.budget.turnBudget),
    String(goal.budget.wallClockBudgetMs),
  ].join('\u0000');
}

function pulseHexColor(fromHex: string, toHex: string, t: number): string {
  const clamp = (v: number): number => Math.max(0, Math.min(1, v));
  const safe = clamp(t);
  const from = parseHexColor(fromHex);
  const to = parseHexColor(toHex);
  if (from === undefined || to === undefined) return fromHex;
  const mix = (s: number, e: number): string =>
    Math.round(s + (e - s) * safe)
      .toString(16)
      .padStart(2, '0');
  return `#${mix(from.red, to.red)}${mix(from.green, to.green)}${mix(from.blue, to.blue)}`;
}

const PULSE_RGB_CACHE = new Map<string, { red: number; green: number; blue: number } | undefined>();

function parseHexColor(hex: string): { red: number; green: number; blue: number } | undefined {
  // Theme tokens repeat every tick; the regex parse is the hot half of the
  // pulse path, so memoize per hex string.
  let parsed = PULSE_RGB_CACHE.get(hex);
  if (parsed !== undefined) return parsed;
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (match === null) {
    parsed = undefined;
  } else {
    parsed = {
      red: Number.parseInt(match[1]!, 16),
      green: Number.parseInt(match[2]!, 16),
      blue: Number.parseInt(match[3]!, 16),
    };
  }
  if (PULSE_RGB_CACHE.size > 64) PULSE_RGB_CACHE.clear();
  PULSE_RGB_CACHE.set(hex, parsed);
  return parsed;
}
