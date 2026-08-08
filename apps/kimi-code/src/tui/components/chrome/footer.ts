/**
 * Footer/status bar — multi-line status display at the bottom of the TUI.
 *
 * Layout:
 *   Line 1: [yolo] [plan] <model> <cwd>  <git-badge>  <shortcut hints>
 *   Line 2: context: N% (tokens/max)
 */

import type { Component } from '@moonshot-ai/pi-tui';
import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { effectiveModelAlias } from '@moonshot-ai/kimi-code-sdk';

import { getAllTips, type ToolbarTip } from '#/tui/constant/tips';
import { isRainbowDancing, renderDanceFooterModel, rainbowText, getDanceRainbowPalette } from '#/tui/easter-eggs/dance';
import { currentTheme } from '#/tui/theme';
import { getLocale, t } from '#/i18n';
import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';
import {
  StatusLineCommandRunner,
  type StatusLinePayload,
} from '#/tui/utils/status-line-command';
import {
  createGitStatusCache,
  formatGitBadgeBase,
  formatPullRequestBadge,
  type GitStatus,
  type GitStatusCache,
} from '#/utils/git/git-status';
import {
  formatTokenCount,
  usagePercent,
  usagePercentFromRatio,
} from '#/utils/usage/usage-format';

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
 * live (active/paused) goal; terminal/no goal -> no badge. Turn count is a raw
 * count unless an explicit turn budget is set, in which case it shows used/limit.
 */
function formatGoalBadge(
  goal: AppState['goal'],
  colors: ColorPalette,
  wallClockMs?: number,
): string | null {
  if (goal === null || goal === undefined) return null;
  // Show the badge for every persisted, resumable status. `complete` clears the
  // goal, so it never reaches here; only the unset case returns null.
  if (goal.status !== 'active' && goal.status !== 'paused' && goal.status !== 'blocked') {
    return null;
  }
  const dotColor =
    goal.status === 'active'
      ? colors.primary
      : goal.status === 'blocked'
        ? colors.warning
        : colors.textMuted;
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
  return (
    chalk.hex(colors.textMuted)('[goal ') +
    chalk.hex(dotColor)('●') +
    chalk.hex(colors.textMuted)(` ${label}]`)
  );
}

function formatBadgeElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function modelDisplayName(state: AppState): string {
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
 * Render the combined swarm-plan badge with a rainbow gradient effect.
 * Each character gets a different color from the theme-appropriate palette.
 */
function renderSwarmPlanBadge(text: string): string {
  const palette = getDanceRainbowPalette();
  return rainbowText(text, palette, 0, true);
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
    return t('tui.chrome.footer.contextWithTokens', { pct, tokens: formatTokenCount(tokens), maxTokens: formatTokenCount(maxTokens) });
  }
  return t('tui.chrome.footer.context', { pct: String(usagePercentFromRatio(usage)) });
}

/**
 * Live cache hit rate and output speed readout, e.g. `cache 87% · 12.3 tok/s`.
 * Hidden until at least one step reported usage (no session traffic yet).
 */
function formatCacheStatus(
  cacheReadTokens: number,
  cacheMissTokens: number,
  tokenSpeed: number,
): string | null {
  const read = cacheReadTokens ?? 0;
  const miss = cacheMissTokens ?? 0;
  const total = read + miss;
  if (total <= 0) return null;
  const pct = String(Math.round((read / total) * 100));
  const speed =
    (tokenSpeed ?? 0) > 0
      ? t('tui.chrome.footer.tokenSpeed', { speed: (tokenSpeed ?? 0).toFixed(1) })
      : '';
  const hit = t('tui.chrome.footer.cacheHit', { pct });
  return speed.length > 0 ? `${hit} · ${speed}` : hit;
}

export function formatFooterGitBadge(status: GitStatus, colors: ColorPalette): string {
  const base = chalk.hex(colors.textDim)(formatGitBadgeBase(status));
  if (status.pullRequest === null) return base;

  const pullRequest = chalk.hex(colors.primary)(
    formatPullRequestBadge(status.pullRequest, { linkPullRequest: true }),
  );
  return `${base} ${pullRequest}`;
}

export class FooterComponent implements Component {
  private state: AppState;
  private readonly onRefresh: () => void;
  private gitCache: GitStatusCache;
  private gitCacheWorkDir: string;
  private transientHint: string | null = null;
  private goalSnapshotKey: string | null = null;
  private goalObservedAtMs = Date.now();
  private goalTimer: ReturnType<typeof setInterval> | null = null;
  private pulseTimer: ReturnType<typeof setInterval> | null = null;
  private pulsePhase = 0;
  private statusLineRunner: StatusLineCommandRunner | null = null;
  /**
   * Non-terminal background-task counts split by kind so the footer can
   * render two distinct badges. `bashTasks` covers `bash-*` BPM tasks
   * spawned via `Shell run_in_background=true`; `agentTasks` covers
   * `agent-*` BPM tasks (background subagents). Either zero hides its
   * respective badge.
   */
  private backgroundBashTaskCount = 0;
  private backgroundAgentCount = 0;

  constructor(state: AppState, onRefresh: () => void = () => {}) {
    this.state = state;
    this.onRefresh = onRefresh;
    this.gitCacheWorkDir = state.workDir;
    this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onRefresh });
    this.syncGoalClock(state.goal);
    this.syncGoalTimer(state.goal);
    this.syncStatusLineRunner(state);
  }

  setState(state: AppState): void {
    if (state.workDir !== this.gitCacheWorkDir) {
      this.gitCacheWorkDir = state.workDir;
      this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onRefresh });
    }
    this.syncGoalClock(state.goal);
    this.syncGoalTimer(state.goal);
    this.syncPulseTimer(state.thinkingEffort !== 'off' && state.streamingPhase !== 'idle');
    this.syncStatusLineRunner(state);
    this.state = state;
  }

  private syncStatusLineRunner(state: AppState): void {
    const command = state.statusLine?.command ?? null;
    if (command === null) {
      this.statusLineRunner?.dispose();
      this.statusLineRunner = null;
      return;
    }
    if (this.statusLineRunner?.command !== command) {
      // A reload can swap one command for another; the old runner would
      // otherwise keep executing the previous script until restart.
      this.statusLineRunner?.dispose();
      this.statusLineRunner = new StatusLineCommandRunner(command, this.onRefresh);
    }
  }

  /**
   * Short-lived hint that replaces the rotating toolbar tips on line 1.
   * Used by the exit-confirmation double-tap flow to show "Press Ctrl+C
   * again to exit" without requiring a toast/overlay subsystem.
   * Pass `null` to clear.
   */
  setTransientHint(hint: string | null): void {
    this.transientHint = hint;
  }

  getTransientHint(): string | null {
    return this.transientHint;
  }

  /**
   * Sync both background-task badges with live counts. Each non-zero
   * count produces its own bracketed badge on line 1; zeros hide them
   * independently.
   */
  setBackgroundCounts(counts: { bashTasks: number; agentTasks: number }): void {
    this.backgroundBashTaskCount = Math.max(0, counts.bashTasks);
    this.backgroundAgentCount = Math.max(0, counts.agentTasks);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const colors = currentTheme.palette;
    const state = this.state;

    // ── Line 1: slots composed per status_line.items, or a user command ──
    let line1: string;
    let customLine: string | null = null;
    if (this.statusLineRunner !== null) {
      this.statusLineRunner.maybeRefresh(this.statusLinePayload());
      customLine = this.statusLineRunner.current();
    }

    if (customLine !== null) {
      // status_line.command: the first stdout line takes over line 1.
      line1 = chalk.hex(colors.text)(customLine);
    } else {
      const slots = this.buildSlots(colors);
      const configured = this.state.statusLine?.items ?? null;
      const order: readonly string[] = configured ?? DEFAULT_STATUS_LINE_ITEMS;
      const left: string[] = [];
      for (const slot of order) {
        const pieces = slots[slot as keyof typeof slots];
        if (pieces !== undefined) left.push(...pieces);
      }

      const leftLine = left.join('  ');
      const leftWidth = visibleWidth(leftLine);

      // Rotating hint tips stay on the right unless they were given an
      // inline slot in items (rendered above at their configured position)
      // or the user dropped 'tips' from items.
      let tipText = '';
      const tipsInline = order.includes('tips');
      const showTips = !tipsInline && (configured === null || configured.includes('tips'));
      if (showTips) {
        const { primary, pair } = tipsForIndex(currentTipIndex());
        const gap = 2;
        const remaining = Math.max(0, width - leftWidth - gap);
        if (pair && visibleWidth(pair) <= remaining) {
          tipText = pair;
        } else if (primary && visibleWidth(primary) <= remaining) {
          tipText = primary;
        }
      }

      if (tipText) {
        const pad = width - leftWidth - visibleWidth(tipText);
        line1 = leftLine + ' '.repeat(Math.max(0, pad)) + chalk.hex(colors.textMuted)(tipText);
      } else if (leftWidth <= width) {
        line1 = leftLine;
      } else {
        line1 = truncateToWidth(leftLine, width, '…');
      }
    }

    // ── Line 2: transient hint (bottom-left) + cache/context (right) ──
    const cacheText = formatCacheStatus(
      state.cacheReadTokens,
      state.cacheMissTokens,
      state.tokenSpeed,
    );
    const contextText = formatContextStatus(
      state.contextUsage,
      state.contextTokens,
      state.maxContextTokens,
    );
    const rightText = cacheText === null ? contextText : `${cacheText}  ${contextText}`;
    const contextWidth = visibleWidth(rightText);
    let line2: string;
    if (this.transientHint) {
      const maxHintWidth = Math.max(0, width - contextWidth - 1);
      const shownHint =
        visibleWidth(this.transientHint) <= maxHintWidth
          ? this.transientHint
          : truncateToWidth(this.transientHint, maxHintWidth, '…');
      const hintWidth = visibleWidth(shownHint);
      const pad = Math.max(0, width - hintWidth - contextWidth);
      line2 =
        chalk.hex(colors.warning).bold(shownHint) +
        ' '.repeat(pad) +
        chalk.hex(colors.text)(rightText);
    } else {
      const leftPad = Math.max(0, width - contextWidth);
      line2 = ' '.repeat(leftPad) + chalk.hex(colors.text)(rightText);
    }

    return [truncateToWidth(line1, width), truncateToWidth(line2, width)];
  }

  /**
   * Rendered pieces per status-line slot. Empty-content slots (e.g. no goal,
   * outside a git repo) yield an empty list so composition just skips them.
   */
  private buildSlots(colors: ColorPalette): Record<string, string[]> {
    const state = this.state;
    const slots: Record<string, string[]> = {
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
      if (tip) slots['tips'] = [chalk.hex(colors.textMuted)(tip)];
    }

    const modes: string[] = [];
    if (state.permissionMode === 'auto') modes.push(chalk.hex(colors.warning).bold(t('tui.chrome.footer.auto')));
    if (state.permissionMode === 'yolo') modes.push(chalk.hex(colors.warning).bold(t('tui.chrome.footer.yolo')));
    if (state.planMode && state.swarmMode) {
      modes.push(renderSwarmPlanBadge(t('tui.chrome.footer.swarmPlan')));
    } else {
      if (state.planMode) modes.push(chalk.hex(colors.primary).bold(t('tui.chrome.footer.plan')));
      if (state.swarmMode) modes.push(chalk.hex(colors.accent).bold(t('tui.chrome.footer.swarm')));
    }
    if (modes.length > 0) slots['mode'] = [modes.join(' ')];

    const goalBadge = formatGoalBadge(state.goal, colors, this.goalWallClockMs(state.goal));
    if (goalBadge !== null) slots['goal'] = [goalBadge];

    const model = modelDisplayName(state);
    if (model) {
      const effort = state.thinkingEffort;
      const rawCurrentModel = state.availableModels[state.model];
      const currentModel =
        rawCurrentModel === undefined ? undefined : effectiveModelAlias(rawCurrentModel);
      // Only effort-capable models (those declaring support_efforts) show the
      // concrete effort; legacy boolean models keep the plain "thinking" suffix.
      const hasEfforts = (currentModel?.supportEfforts?.length ?? 0) > 0;
      const thinkingLabel =
        effort !== 'off'
          ? hasEfforts && effort !== 'on'
            ? t('tui.chrome.footer.thinkingEffort', { effort })
            : t('tui.chrome.footer.thinking')
          : '';
      const thinkingColor = this.pulsePhase > 0
        ? pulseHexColor(colors.textDim, colors.text, Math.sin(this.pulsePhase * Math.PI))
        : colors.text;
      const modelLabel = `${model}${thinkingLabel}`;
      let renderedModelLabel =
        chalk.hex(colors.text)(model) +
        (thinkingLabel ? chalk.hex(thinkingColor)(thinkingLabel) : '');
      if (isRainbowDancing()) {
        renderedModelLabel = renderDanceFooterModel(modelLabel);
      }
      slots['model'] = [renderedModelLabel];
    }

    // Background-task badges. `bash-*` tasks (shell processes) and `agent-*`
    // tasks (background subagents) stay separate so the user can tell them
    // apart at a glance.
    const taskBadges: string[] = [];
    if (this.backgroundBashTaskCount > 0) {
      const noun = t(
        this.backgroundBashTaskCount === 1
          ? 'tui.chrome.footer.task_one'
          : 'tui.chrome.footer.task_other',
        { count: String(this.backgroundBashTaskCount) },
      );
      taskBadges.push(chalk.hex(colors.primary)(`[${noun}]`));
    }
    if (this.backgroundAgentCount > 0) {
      const noun = t(
        this.backgroundAgentCount === 1
          ? 'tui.chrome.footer.agent_one'
          : 'tui.chrome.footer.agent_other',
        { count: String(this.backgroundAgentCount) },
      );
      taskBadges.push(chalk.hex(colors.primary)(`[${noun}]`));
    }
    slots['tasks'] = taskBadges;

    const cwd = shortenCwd(state.workDir);
    if (cwd) slots['cwd'] = [chalk.hex(colors.textDim)(cwd)];

    const git = this.gitCache.getStatus();
    if (git !== null) slots['git'] = [formatFooterGitBadge(git, colors)];

    return slots;
  }

  private statusLinePayload(): StatusLinePayload {
    const state = this.state;
    return {
      model: modelDisplayName(state),
      cwd: state.workDir,
      gitBranch: this.gitCache.getStatus()?.branch ?? null,
      permissionMode: state.permissionMode,
      planMode: state.planMode,
      contextUsage: state.contextUsage,
      contextTokens: state.contextTokens,
      maxContextTokens: state.maxContextTokens,
      sessionId: state.sessionId,
      version: state.version,
    };
  }

  private syncGoalClock(goal: AppState['goal']): void {
    const key = goalSnapshotKey(goal);
    if (key === this.goalSnapshotKey) return;
    this.goalSnapshotKey = key;
    this.goalObservedAtMs = Date.now();
  }

  private syncGoalTimer(goal: AppState['goal']): void {
    if (goal?.status === 'active') {
      if (this.goalTimer !== null) return;
      this.goalTimer = setInterval(() => {
        this.onRefresh();
      }, GOAL_TIMER_INTERVAL_MS);
      this.goalTimer.unref?.();
      return;
    }

    if (this.goalTimer !== null) {
      clearInterval(this.goalTimer);
      this.goalTimer = null;
    }
  }

  private syncPulseTimer(thinking: boolean): void {
    if (thinking) {
      if (this.pulseTimer !== null) return;
      this.pulseTimer = setInterval(() => {
        this.pulsePhase = (this.pulsePhase + 0.05) % 1;
        this.onRefresh();
      }, THINKING_PULSE_INTERVAL_MS);
      this.pulseTimer.unref?.();
      return;
    }
    if (this.pulseTimer !== null) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
    this.pulsePhase = 0;
  }

  dispose(): void {
    if (this.goalTimer !== null) {
      clearInterval(this.goalTimer);
      this.goalTimer = null;
    }
    if (this.pulseTimer !== null) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
  }

  private goalWallClockMs(goal: AppState['goal']): number | undefined {
    if (goal === null || goal === undefined) return undefined;
    if (goal.status !== 'active') return goal.wallClockMs;
    return goal.wallClockMs + Math.max(0, Date.now() - this.goalObservedAtMs);
  }
}

function goalSnapshotKey(goal: AppState['goal']): string | null {
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

function parseHexColor(hex: string): { red: number; green: number; blue: number } | undefined {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (match === null) return undefined;
  return {
    red: Number.parseInt(match[1]!, 16),
    green: Number.parseInt(match[2]!, 16),
    blue: Number.parseInt(match[3]!, 16),
  };
}
