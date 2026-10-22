/**
 * TasksPanelComponent — the background-tasks panel.
 *
 * Two columns: the task list on the left, and on the right the detail of the
 * selected task told as a narrative — what it is doing, where it runs and how
 * far it got, how it ended, and what it printed. The noisy identifier fields
 * (pid, agent id, effort, tool call) stay hidden behind the raw view.
 *
 * The panel never reads the terminal size: the controller computes the height
 * and hands it in, so the same component can own a full-screen takeover or
 * sit inside a smaller region.
 *
 * Mounted by `controllers/tasks-browser.ts` — the controller swaps the main
 * TUI children for this component and restores them when the user leaves.
 */

import type { BackgroundTaskInfo, ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import type { SubagentActivityRecord } from '#/tui/controllers/subagent-activity-store';
import { currentTheme } from '#/tui/theme';
import {
  isActiveTaskStatus,
  isTerminalTaskStatus,
  taskDetailSections,
  taskIdLine,
  taskRawFields,
  taskRowText,
  taskStatusLabel,
  taskStatusToken,
  type TaskDetailContext,
} from '#/tui/utils/background-task';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';
import { renderTabStrip } from '#/tui/utils/tab-strip';

import { AgentActivityViewer } from './agent-activity-viewer';
import { modelDisplayName } from './model-selector';

const ELLIPSIS = '…';

/** Minimum dimensions before we just print a "too small" message. */
const MIN_WIDTH = 48;
const MIN_HEIGHT = 14;

/** Below this width the two columns stack instead of sitting side by side. */
const NARROW_WIDTH = 88;

/** Hard caps so a tiny / huge terminal still gets a sensible list column. */
const LIST_COL_MIN = 28;
const LIST_COL_MAX = 44;
const LIST_COL_RATIO = 0.32;

/** Chrome rows: top rule, title, hint, blank, tab strip, blank. */
const CHROME_ROWS = 6;

/** Rows a page-up / page-down moves the list cursor. */
const LIST_PAGE_SIZE = 10;

/** Indentation of the detail values under their section label. */
const DETAIL_INDENT = '  ';

export type TasksTab = 'all' | 'running' | 'finished';

const TASKS_TABS: readonly TasksTab[] = ['all', 'running', 'finished'];

export interface TasksPanelProps {
  readonly tasks: readonly BackgroundTaskInfo[];
  readonly tab: TasksTab;
  readonly selectedTaskId: string | undefined;
  /** Rows the panel may use. The controller owns the terminal geometry. */
  readonly height: number;
  /** Captured output of the selected task, straight from the engine. */
  readonly output: string | undefined;
  readonly outputLoading: boolean;
  /** In-memory activity of the selected agent task, when this session holds one. */
  readonly activity: SubagentActivityRecord | undefined;
  /** Working directory the task ran in. */
  readonly cwd: string | undefined;
  readonly flashMessage: string | undefined;
  /** Model catalog from the app config, used to resolve task model aliases
   *  to display names (same mapping as the other subagent surfaces). */
  readonly availableModels: Record<string, ModelAlias>;
  readonly onSelect: (taskId: string) => void;
  readonly onTabChange: (tab: TasksTab) => void;
  readonly onRefresh: () => void;
  readonly onCancel: () => void;
  /** Fired when the user confirms a stop with a second `S`. */
  readonly onStop: (taskId: string) => void;
  /** Fired when stop is requested on a task that cannot be stopped. */
  readonly onStopIgnored?: (taskId: string, reason: 'terminal') => void;
}

/** Which part of the panel the keyboard drives. */
type PanelFocus = 'list' | 'output';

export class TasksPanelComponent extends Container implements Focusable {
  focused = false;

  private props: TasksPanelProps;
  private list: SearchableList<BackgroundTaskInfo> | undefined;
  private listScroll = 0;
  /** Last task id the panel reported, to tell its own selection apart. */
  private emittedTaskId: string | undefined;
  private readonly activityViewer: AgentActivityViewer;
  private rawView = false;
  private focus: PanelFocus = 'list';
  private pendingStopTaskId: string | undefined;
  private outputLines: string[] = [];
  private outputScrollTop = 0;
  private outputFollowTail = true;
  /** Rows the output block had on its last render — the tail window size. */
  private outputRows = 1;
  /** Width of the detail column on the last render. */
  private detailWidth = 80;

  constructor(props: TasksPanelProps) {
    super();
    this.props = props;
    this.activityViewer = new AgentActivityViewer({
      record: props.activity,
      workspaceDir: props.cwd,
      expanded: false,
    });
    this.syncOutput();
  }

  setProps(next: TasksPanelProps): void {
    this.props = next;
    this.activityViewer.setProps({
      record: next.activity,
      workspaceDir: next.cwd,
      expanded: this.rawView,
    });
    this.syncOutput();
    this.invalidate();
  }

  // ── input ──────────────────────────────────────────────────────────

  handleInput(data: string): void {
    const k = printableChar(data);
    this.ensureList(this.visibleTasks());

    // A pending stop is armed by the first `S`; any other key cancels it.
    if (this.pendingStopTaskId !== undefined) {
      const armed = this.pendingStopTaskId;
      this.pendingStopTaskId = undefined;
      if (k === 's' || k === 'S') {
        this.props.onStop(armed);
        this.invalidate();
        return;
      }
    }

    if (matchesKey(data, Key.escape)) {
      if (this.focus === 'output') {
        this.focus = 'list';
        this.invalidate();
        return;
      }
      this.props.onCancel();
      return;
    }
    if (k === 'q' || k === 'Q') {
      this.props.onCancel();
      return;
    }
    if (matchesKey(data, Key.ctrl('o'))) {
      this.rawView = !this.rawView;
      this.activityViewer.setProps({
        record: this.props.activity,
        workspaceDir: this.props.cwd,
        expanded: this.rawView,
      });
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.cycleTab(1);
      return;
    }
    if (matchesKey(data, Key.shift('tab'))) {
      this.cycleTab(-1);
      return;
    }
    if (k === 'r' || k === 'R') {
      this.props.onRefresh();
      return;
    }
    if (k === 's' || k === 'S') {
      this.requestStop();
      return;
    }
    if (k === 'o' || k === 'O' || matchesKey(data, Key.enter)) {
      this.focus = this.focus === 'output' ? 'list' : 'output';
      this.invalidate();
      return;
    }

    if (this.focus === 'output') {
      if (this.handleOutputScroll(data, k)) return;
      return;
    }

    if (this.list?.handleKey(data) === true) {
      this.emitSelect();
      this.invalidate();
    }
  }

  private handleOutputScroll(data: string, k: string): boolean {
    const page = Math.max(1, this.outputRows - 1);
    if (matchesKey(data, Key.up) || k === 'k') {
      this.scrollOutput(-1);
      return true;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      this.scrollOutput(1);
      return true;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl('u'))) {
      this.scrollOutput(-page);
      return true;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl('d'))) {
      this.scrollOutput(page);
      return true;
    }
    if (matchesKey(data, Key.home) || k === 'g') {
      this.scrollOutputTo(0);
      return true;
    }
    if (matchesKey(data, Key.end) || k === 'G') {
      this.scrollOutputTo(Number.MAX_SAFE_INTEGER);
      return true;
    }
    return false;
  }

  private scrollOutput(delta: number): void {
    this.scrollOutputTo(this.outputScrollTop + delta);
  }

  private scrollOutputTo(target: number): void {
    const max = this.maxOutputScroll();
    this.outputScrollTop = Math.max(0, Math.min(target, max));
    this.outputFollowTail = this.outputScrollTop >= max;
    this.invalidate();
  }

  private requestStop(): void {
    const task = this.selectedTask();
    if (task === undefined) return;
    if (isTerminalTaskStatus(task.status)) {
      this.props.onStopIgnored?.(task.taskId, 'terminal');
      return;
    }
    this.pendingStopTaskId = task.taskId;
    this.invalidate();
  }

  private cycleTab(delta: number): void {
    const index = TASKS_TABS.indexOf(this.props.tab);
    const next = TASKS_TABS[(index + delta + TASKS_TABS.length) % TASKS_TABS.length];
    if (next !== undefined) this.props.onTabChange(next);
  }

  private emitSelect(): void {
    const task = this.list?.selected();
    if (task === undefined) return;
    this.emittedTaskId = task.taskId;
    this.props.onSelect(task.taskId);
  }

  // ── data ───────────────────────────────────────────────────────────

  private visibleTasks(): BackgroundTaskInfo[] {
    // The /tasks panel is for background task management. Foreground tasks
    // (detached === false) are shown in the main transcript instead, and only
    // appear here after being detached via Ctrl+B. `detached !== false` keeps
    // reconcile ghosts whose `detached` field may be undefined.
    const backgroundOnly = this.props.tasks.filter((task) => task.detached !== false);
    switch (this.props.tab) {
      case 'all':
        return backgroundOnly;
      case 'running':
        return backgroundOnly.filter((task) => isActiveTaskStatus(task.status));
      case 'finished':
        return backgroundOnly.filter((task) => isTerminalTaskStatus(task.status));
    }
  }

  private selectedTask(): BackgroundTaskInfo | undefined {
    return this.list?.selected();
  }

  private syncOutput(): void {
    const output = this.props.output;
    if (output === undefined || output.length === 0) {
      this.outputLines = [];
      return;
    }
    this.outputLines = sanitizeShellOutput(output).split('\n');
  }

  private modelName(task: BackgroundTaskInfo): string | undefined {
    if (task.kind !== 'agent' || task.model === undefined) return undefined;
    const name = modelDisplayName(task.model, this.props.availableModels[task.model]);
    return name.length === 0 ? undefined : name;
  }

  // ── render ─────────────────────────────────────────────────────────

  override render(width: number): string[] {
    const height = Math.max(1, this.props.height);
    if (width < MIN_WIDTH || height < MIN_HEIGHT) {
      return this.renderTooSmall(width, height);
    }

    const bodyHeight = Math.max(1, height - CHROME_ROWS - 1);
    const out: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      ...this.renderChrome(width),
      ...this.renderBody(width, bodyHeight),
      currentTheme.fg('primary', '─'.repeat(width)),
    ];
    return out;
  }

  private renderChrome(width: number): string[] {
    const title = currentTheme.boldFg('primary', t('tui.dialogs.tasksBrowser.panelTitle'));
    const tabs = renderTabStrip({
      labels: [
        t('tui.dialogs.tasksBrowser.tabAll'),
        t('tui.dialogs.tasksBrowser.tabRunning'),
        t('tui.dialogs.tasksBrowser.tabFinished'),
      ],
      activeIndex: Math.max(0, TASKS_TABS.indexOf(this.props.tab)),
      width,
      colors: currentTheme.palette,
    });
    return [title, this.renderHint(width), '', tabs, ''];
  }

  private renderHint(width: number): string {
    const segments = [
      `Tab ${t('tui.dialogs.tasksBrowser.hintFilter')}`,
      `↑↓ ${t('tui.dialogs.tasksBrowser.hintNavigate')}`,
      `Enter/O ${t('tui.dialogs.tasksBrowser.hintOutput')}`,
      `S ${t('tui.dialogs.tasksBrowser.hintStop')}`,
      `R ${t('tui.dialogs.tasksBrowser.hintRefresh')}`,
      `Ctrl+O ${t('tui.dialogs.tasksBrowser.hintRaw')}`,
      `Esc ${t('tui.dialogs.tasksBrowser.hintCancel')}`,
    ];
    // The first and the last segment always survive; the ones in between are
    // dropped first when the terminal is too narrow for the whole line.
    const kept = [...segments];
    while (kept.length > 2 && visibleWidth(kept.join(' · ')) + 1 > width) {
      kept.splice(kept.length - 2, 1);
    }
    const styled = currentTheme.fg('textMuted', ` ${kept.join(' · ')}`);
    const flash = this.props.flashMessage;
    if (flash !== undefined && flash.length > 0) {
      const flashStyled = currentTheme.fg('warning', ` ${flash} `);
      const used = visibleWidth(styled) + visibleWidth(flashStyled);
      if (used <= width) return styled + ' '.repeat(width - used) + flashStyled;
    }
    return fitExactly(styled, width);
  }

  private renderBody(width: number, height: number): string[] {
    if (width < NARROW_WIDTH) {
      // Stacked: the list keeps at most 40% of the rows but never more than
      // what the detail can spare, so the narrative still has room to breathe.
      const listHeight = Math.max(
        3,
        Math.min(Math.floor(height * 0.4), Math.max(3, height - 6)),
      );
      const detailHeight = Math.max(1, height - listHeight);
      this.detailWidth = width;
      return [
        ...this.renderList(width, listHeight),
        ...this.renderDetail(width, detailHeight),
      ];
    }

    const listWidth = Math.max(
      LIST_COL_MIN,
      Math.min(LIST_COL_MAX, Math.floor(width * LIST_COL_RATIO)),
    );
    const detailWidth = Math.max(1, width - listWidth - 1);
    this.detailWidth = detailWidth;
    const list = this.renderList(listWidth, height);
    const detail = this.renderDetail(detailWidth, height);
    const separator = currentTheme.fg('border', '│');
    const out: string[] = [];
    for (let i = 0; i < height; i++) {
      out.push(
        fitExactly(list[i] ?? '', listWidth) + separator + fitExactly(detail[i] ?? '', detailWidth),
      );
    }
    return out;
  }

  // ── list column ────────────────────────────────────────────────────

  private renderList(width: number, height: number): string[] {
    const items = this.visibleTasks();
    if (items.length === 0) {
      const empty = currentTheme.fg('textMuted', this.emptyMessage());
      const out: string[] = [empty];
      while (out.length < height) out.push('');
      return out;
    }

    this.ensureList(items);
    const selectedIndex = this.list?.view().selectedIndex ?? 0;
    this.adjustScroll(items.length, selectedIndex, height);

    const rows = Math.max(1, height);
    const more = items.length - (this.listScroll + rows);
    const out: string[] = [];
    for (let i = 0; i < rows; i++) {
      const task = items[this.listScroll + i];
      if (task === undefined) {
        out.push('');
        continue;
      }
      out.push(this.renderRow(task, this.listScroll + i === selectedIndex, width));
    }
    if (more > 0 && out.length > 0) {
      out[out.length - 1] = fitExactly(
        currentTheme.fg('textMuted', t('tui.dialogs.tasksBrowser.scrollMore', { count: more })),
        width,
      );
    }
    return out;
  }

  private emptyMessage(): string {
    switch (this.props.tab) {
      case 'running':
        return t('tui.dialogs.tasksBrowser.noRunningTasks');
      case 'finished':
        return t('tui.dialogs.tasksBrowser.noFinishedTasks');
      case 'all':
        return t('tui.dialogs.tasksBrowser.noBackgroundTasks');
    }
  }

  private ensureList(items: readonly BackgroundTaskInfo[]): void {
    const current = this.list;
    const currentIds = current === undefined ? '' : current.filtered().map((t) => t.taskId).join(',');
    const nextIds = items.map((t) => t.taskId).join(',');
    const selectedId = this.props.selectedTaskId;
    const listSelectedId = current?.selected()?.taskId;
    // A selection the panel itself reported is not an external change — only
    // a selection the controller made on its own moves the cursor back.
    const selectionMoved =
      selectedId !== undefined &&
      selectedId !== listSelectedId &&
      selectedId !== this.emittedTaskId;
    if (current !== undefined && currentIds === nextIds && !selectionMoved) {
      return;
    }
    const index = selectedId === undefined ? -1 : items.findIndex((t) => t.taskId === selectedId);
    this.list = new SearchableList<BackgroundTaskInfo>({
      items,
      toSearchText: taskRowText,
      searchable: false,
      pageSize: LIST_PAGE_SIZE,
      initialIndex: index >= 0 ? index : (current?.view().selectedIndex ?? 0),
    });
  }

  private adjustScroll(total: number, selectedIndex: number, rows: number): void {
    if (selectedIndex < this.listScroll) {
      this.listScroll = selectedIndex;
    } else if (selectedIndex >= this.listScroll + rows) {
      this.listScroll = selectedIndex - rows + 1;
    }
    const maxScroll = Math.max(0, total - rows);
    this.listScroll = Math.max(0, Math.min(this.listScroll, maxScroll));
  }

  private renderRow(task: BackgroundTaskInfo, selected: boolean, width: number): string {
    const pointer = selected ? `${SELECT_POINTER} ` : '  ';
    const pointerStyled = currentTheme.fg(selected ? 'primary' : 'textDim', pointer);
    const pending = this.pendingStopTaskId === task.taskId;
    const statusText = pending
      ? currentTheme.boldFg('warning', t('tui.dialogs.tasksBrowser.stopConfirmHint'))
      : currentTheme.fg(taskStatusToken(task.status), taskStatusLabel(task.status));
    const statusWidth = visibleWidth(statusText);
    const budget = Math.max(0, width - visibleWidth(pointerStyled) - statusWidth - 1);
    const clipped = truncateToWidth(taskRowText(task), budget, ELLIPSIS);
    const name = selected
      ? currentTheme.boldFg('primary', clipped)
      : currentTheme.fg('text', clipped);
    const gap = Math.max(1, width - visibleWidth(pointerStyled) - visibleWidth(clipped) - statusWidth);
    return fitExactly(`${pointerStyled}${name}${' '.repeat(gap)}${statusText}`, width);
  }

  // ── detail column ──────────────────────────────────────────────────

  private renderDetail(width: number, height: number): string[] {
    const task = this.selectedTask();
    if (task === undefined) {
      const out: string[] = [
        currentTheme.fg('textMuted', t('tui.dialogs.tasksBrowser.noTaskSelected')),
      ];
      while (out.length < height) out.push('');
      return out;
    }

    const lines: string[] = [];
    const context: TaskDetailContext = {
      cwd: this.props.cwd,
      outputBytes: this.outputBytes(),
      modelName: this.modelName(task),
    };
    for (const section of taskDetailSections(task, context)) {
      lines.push(section.label);
      for (const line of section.lines) lines.push(indent(line));
    }
    if (this.rawView) {
      const raw = taskRawFields(task);
      if (raw.lines.length > 0) {
        lines.push(raw.label);
        for (const line of raw.lines) lines.push(indent(line));
      }
    }
    const blocks = this.streamBlocks(task);
    // The task id is demoted to the very last line of the detail, so one row
    // is reserved for it before the streams claim the rest.
    const remaining = Math.max(0, height - lines.length - 1);
    const budgets = this.streamBudgets(blocks, remaining);
    blocks.forEach((block, index) => {
      const budget = budgets[index] ?? 0;
      if (budget <= 0) return;
      lines.push(
        currentTheme.boldFg(
          'textStrong',
          t(
            block === 'activity'
              ? 'tui.dialogs.tasksBrowser.sectionActivity'
              : 'tui.dialogs.tasksBrowser.sectionOutput',
          ),
        ),
      );
      if (budget <= 1) return;
      lines.push(...this.blockContent(block, budget - 1));
    });
    lines.push(indent(taskIdLine(task)));

    while (lines.length < height) lines.push('');
    return lines
      .slice(0, height)
      .map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  /** Which streams the detail shows, and in which order. */
  private streamBlocks(task: BackgroundTaskInfo): readonly ('activity' | 'output')[] {
    if (task.kind !== 'agent') return ['output'];
    return isActiveTaskStatus(task.status) ? ['activity', 'output'] : ['output', 'activity'];
  }

  /**
   * Split the rows left over between the streams. The output section is the
   * one the user always expects to see, so it claims a label row before the
   * activity section does.
   */
  private streamBudgets(
    blocks: readonly ('activity' | 'output')[],
    remaining: number,
  ): number[] {
    const budgets = blocks.map(() => 0);
    if (blocks.length === 0 || remaining <= 0) return budgets;
    const per = Math.floor(remaining / blocks.length);
    let extra = remaining - per * blocks.length;
    for (const index of budgets.keys()) {
      budgets[index] = per;
      if (extra > 0) {
        budgets[index] = per + 1;
        extra -= 1;
      }
    }
    const outputIndex = blocks.indexOf('output');
    if (outputIndex >= 0 && (budgets[outputIndex] ?? 0) === 0) {
      budgets[outputIndex] = 1;
      const donor = budgets.findIndex((budget, index) => index !== outputIndex && budget > 0);
      if (donor >= 0) budgets[donor] = (budgets[donor] ?? 0) - 1;
    }
    return budgets;
  }

  private blockContent(block: 'activity' | 'output', rows: number): string[] {
    if (block === 'activity') {
      if (this.props.activity === undefined) {
        return [
          indent(currentTheme.fg('textMuted', t('tui.dialogs.tasksBrowser.activityUnavailable'))),
        ];
      }
      return this.activityViewer
        .renderLines(Math.max(1, this.detailWidth - DETAIL_INDENT.length), rows)
        .map((line) => indent(line));
    }
    return this.outputContent(rows).map((line) => indent(line));
  }

  private outputContent(rows: number): string[] {
    this.outputRows = Math.max(1, rows);
    if (this.props.outputLoading) {
      return [currentTheme.fg('textMuted', t('tui.dialogs.tasksBrowser.loadingOutput'))];
    }
    if (this.outputLines.length === 0) {
      return [currentTheme.fg('textMuted', t('tui.dialogs.tasksBrowser.noOutputCaptured'))];
    }
    const max = this.maxOutputScroll();
    if (this.outputFollowTail) this.outputScrollTop = max;
    else this.outputScrollTop = Math.min(this.outputScrollTop, max);
    const slice = this.outputLines.slice(this.outputScrollTop, this.outputScrollTop + rows);
    return slice.map((line) => currentTheme.fg('textDim', line));
  }

  private maxOutputScroll(): number {
    return Math.max(0, this.outputLines.length - this.outputRows);
  }

  private outputBytes(): number | undefined {
    const output = this.props.output;
    if (output === undefined || output.length === 0) return undefined;
    return new TextEncoder().encode(output).length;
  }

  // ── fallback ───────────────────────────────────────────────────────

  private renderTooSmall(width: number, height: number): string[] {
    const msg = currentTheme.fg(
      'error',
      t('tui.dialogs.tasksBrowser.tooSmall', { minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT }),
    );
    const out: string[] = [fitExactly(msg, width)];
    for (let i = 1; i < height; i++) out.push(' '.repeat(width));
    return out;
  }
}

function indent(line: string): string {
  return `${DETAIL_INDENT}${line}`;
}

function fitExactly(line: string, width: number): string {
  const clipped = visibleWidth(line) > width ? truncateToWidth(line, width, ELLIPSIS) : line;
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
}
