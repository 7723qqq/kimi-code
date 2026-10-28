/**
 * ApprovalPanel — the approval request UI that replaces the editor.
 *
 * A DockSection: the title is the head, the request (command, diff, …) is the
 * body, and the choices with their key hints are the foot. Docked in
 * fullscreen, a long request scrolls while the choices stay on screen.
 */

import {
  Input,
  matchesKey,
  Key,
  decodeKittyPrintable,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { isSettlingClick } from '#/tui/utils/terminal-focus';
import { DockSection, type DockLayout, type DockPart } from '#/tui/components/chrome/dock-section';
import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { renderDiffLinesClustered } from '#/tui/components/media/diff-preview';
import type {
  ApprovalPanelChoice,
  DiffDisplayBlock,
  DisplayBlock,
  FileContentDisplayBlock,
  PendingApproval,
} from '#/tui/reverse-rpc/types';
import { currentTheme } from '#/tui/theme';

export interface ApprovalPanelResponse {
  readonly response: 'approved' | 'approved_for_session' | 'rejected' | 'cancelled';
  readonly feedback?: string | undefined;
  readonly selected_label?: string | undefined;
}

function truncateOneLine(text: string, max: number): string {
  const firstLine = text.split('\n')[0] ?? '';
  return firstLine.length > max ? firstLine.slice(0, max - 1) + '…' : firstLine;
}

const DIFF_SUMMARY_MAX_LINES = 10;
const CONTENT_SUMMARY_MAX_LINES = 10;
/**
 * How many display blocks the body draws before summarising the rest.
 *
 * A cap exists so one approval carrying a dozen edits cannot push the choices
 * off the screen; `hiddenBlockCount` is what keeps the cap honest.
 */
const MAX_VISIBLE_BLOCKS = 5;
/**
 * Narrowest inline feedback field worth keeping on the label's line.
 *
 * Below this the Input would show only a character or two of a rejection reason
 * (and CJK, at two columns per glyph, would show less), so the field moves to
 * its own line rather than being squeezed.
 */
const MIN_INLINE_FEEDBACK_WIDTH = 24;

interface BlockStyles {
  strong: (s: string) => string;
  dim: (s: string) => string;
  accent: (s: string) => string;
  gutter: (s: string) => string;
  errorBold: (s: string) => string;
}

function makeBlockStyles(): BlockStyles {
  return {
    strong: (s) => currentTheme.fg('textStrong', s),
    dim: (s) => currentTheme.fg('textDim', s),
    accent: (s) => currentTheme.fg('accent', s),
    gutter: (s) => currentTheme.fg('diffGutter', s),
    errorBold: (s) => currentTheme.boldFg('error', s),
  };
}

function appendWrappedLine(
  lines: string[],
  firstPrefix: string,
  continuationPrefix: string,
  content: string,
  width: number,
): void {
  const prefixWidth = Math.max(visibleWidth(firstPrefix), visibleWidth(continuationPrefix));
  const wrapped = wrapTextWithAnsi(content, Math.max(1, width - prefixWidth));
  if (wrapped.length === 0) {
    lines.push(firstPrefix);
    return;
  }
  lines.push(`${firstPrefix}${wrapped[0] ?? ''}`);
  for (let i = 1; i < wrapped.length; i++) {
    lines.push(`${continuationPrefix}${wrapped[i] ?? ''}`);
  }
}

function renderShellDisplayBlock(
  block: Extract<DisplayBlock, { type: 'shell' }>,
  s: BlockStyles,
  width: number,
): string[] {
  const lines: string[] = [];
  if (block.cwd !== undefined && block.cwd.length > 0) {
    lines.push(s.dim(t('tui.approvalPanel.shellCwd', { dir: block.cwd })));
  }
  if (block.danger !== undefined) {
    lines.push(s.errorBold(t('tui.approvalPanel.shellDangerous', { reason: block.danger })));
  }
  const cmdLines = block.command.length > 0 ? block.command.split('\n') : [''];
  cmdLines.forEach((cmdLine, idx) => {
    const prefix =
      idx === 0
        ? s.accent(t('tui.approvalPanel.shellPrompt'))
        : s.dim(t('tui.approvalPanel.shellContinuation'));
    appendWrappedLine(lines, prefix, '  ', s.strong(cmdLine), width);
  });
  if (block.description !== undefined && block.description.length > 0) {
    lines.push(`  ${s.dim(block.description)}`);
  }
  return lines;
}

function renderDisplayBlock(block: DisplayBlock, s: BlockStyles, contentWidth: number): string[] {
  switch (block.type) {
    case 'diff':
      return renderDiffLinesClustered(block.old_text, block.new_text, block.path, {
        contextLines: 3,
        expandKeyHint: t('tui.dialogs.approvalPanel.previewHint'),
        maxLines: DIFF_SUMMARY_MAX_LINES,
      });
    case 'file_content': {
      const lang = block.language ?? langFromPath(block.path);
      const allLines = highlightLines(block.content, lang);
      const shown = allLines.slice(0, CONTENT_SUMMARY_MAX_LINES);
      const lines = [s.strong(block.path)];
      for (const [i, line] of shown.entries()) {
        lines.push(s.gutter(String(i + 1).padStart(4) + '  ') + line);
      }
      const remaining = allLines.length - shown.length;
      if (remaining > 0) {
        lines.push(
          s.dim(
            `     ${t(
              remaining === 1
                ? 'tui.dialogs.approvalPanel.moreLinesHidden_one'
                : 'tui.dialogs.approvalPanel.moreLinesHidden_other',
              { count: remaining, previewHint: t('tui.dialogs.approvalPanel.previewHint') },
            )}`,
          ),
        );
      }
      return lines;
    }
    case 'shell':
      return renderShellDisplayBlock(block, s, contentWidth);
    case 'file_op': {
      const op = s.accent(block.operation.padEnd(5));
      const lines = [`${op} ${s.strong(block.path)}`];
      if (block.detail !== undefined && block.detail.length > 0) {
        lines.push(s.dim(block.detail));
      }
      return lines;
    }
    case 'url_fetch': {
      const method = s.accent((block.method ?? 'GET').toUpperCase().padEnd(5));
      return [`${method} ${s.strong(block.url)}`];
    }
    case 'search': {
      const lines = [`${s.accent(t('tui.approvalPanel.searchPrefix'))} ${s.strong(block.query)}`];
      if (block.scope !== undefined && block.scope.length > 0) {
        lines.push(s.dim(t('tui.approvalPanel.searchScope', { scope: block.scope })));
      }
      return lines;
    }
    case 'invocation': {
      const lines = [`${s.accent(block.kind.padEnd(5))} ${s.strong(block.name)}`];
      if (block.description !== undefined && block.description.length > 0) {
        lines.push(s.dim(truncateOneLine(block.description, 200)));
      }
      return lines;
    }
    case 'brief':
      return block.text
        ? block.text.split('\n').map((line) => (line.length > 0 ? s.strong(line) : ''))
        : [];
    case 'background_task':
      return [
        s.strong(
          t('tui.approvalPanel.backgroundTask', {
            status: block.status,
            kind: block.kind,
            taskId: block.task_id,
            description: block.description,
          }),
        ),
      ];
    case 'todo':
      return block.items.map((item) => s.strong(`- [${item.status}] ${item.title}`));
    default:
      return [];
  }
}

function normalizeApprovalText(text: string): string {
  return text.replaceAll('\r\n', '\n').trim();
}

function isDuplicateBriefBlock(block: DisplayBlock, description: string): boolean {
  if (block.type !== 'brief' || block.text.trim().length === 0) return false;
  const normalizedDescription = normalizeApprovalText(description);
  if (normalizedDescription.length === 0) return false;
  const normalizedBlockText = normalizeApprovalText(block.text);
  if (normalizedBlockText === normalizedDescription) return true;
  const blockLines = normalizedBlockText.split('\n');
  if (blockLines.length <= 1) return false;
  return normalizeApprovalText(blockLines.slice(1).join('\n')) === normalizedDescription;
}

function headerFor(toolName: string): string {
  switch (toolName) {
    case 'Bash':
      return t('tui.dialogs.approvalPanel.headerForBash');
    case 'Write':
      return t('tui.dialogs.approvalPanel.headerForWrite');
    case 'Edit':
      return t('tui.dialogs.approvalPanel.headerForEdit');
    case 'TaskStop':
      return t('tui.dialogs.approvalPanel.headerForTaskStop');
    case 'ExitPlanMode':
      return t('tui.dialogs.approvalPanel.headerForExitPlanMode');
    default:
      return t('tui.dialogs.approvalPanel.headerForDefault', { toolName });
  }
}

export interface ApprovalPanelOptions {
  /** Dock the panel (fullscreen): the request body scrolls past this many rows. */
  readonly layout?: DockLayout;
  /** Whether the terminal window has focus; the panel fades while it does not. */
  readonly isTerminalFocused?: () => boolean;
  /** `Ctrl+N`: hand the keyboard to the Updates panel; false when it has nothing to show. */
  readonly onFocusUpdates?: () => boolean;
  /**
   * Whether the user was mid-keystroke when this prompt appeared.
   *
   * An approval is the one dialog that interrupts rather than being opened: it
   * arrives while the user is composing a message, so the Enter that was about
   * to send it would instead approve an `rm -rf`. When this is true the first
   * *committing* keystroke is dropped once, and only in the approve direction —
   * rejecting, navigating and opening the feedback input stay live, so the worst
   * case is one extra Enter.
   *
   * A time window was tried first and rejected: it cannot tell "the user was
   * typing" from "the user pressed a number right after the panel appeared",
   * so it silently swallowed the numeric shortcuts this panel exists to offer.
   * This carries the actual fact instead of guessing at it from a clock.
   */
  readonly wasTyping?: boolean;
}

export class ApprovalPanelComponent extends DockSection implements Focusable {
  focused = false;
  private selectedIndex = 0;
  private feedbackMode = false;
  private readonly feedbackInput = new Input();
  private onResponse: (response: ApprovalPanelResponse) => void;
  private request: PendingApproval;
  private readonly onToggleToolOutput: (() => void) | undefined;
  private readonly onOpenPreview:
    | ((block: DiffDisplayBlock | FileContentDisplayBlock) => void)
    | undefined;
  private readonly isTerminalFocused: () => boolean;
  private readonly onFocusUpdates: (() => boolean) | undefined;
  /** A click this soon after the panel appeared was aimed at what was there before. */
  private readonly shownAt = Date.now();
  /**
   * Set while the user's in-flight keystroke is still owed a drop.
   *
   * Starts true only when the prompt interrupted live typing, and clears on the
   * first committing keystroke so exactly one press is swallowed.
   */
  private swallowNextCommit: boolean;
  /** Foot row of each choice in the last render, for mouse hit-testing. */
  private choiceRows: readonly number[] = [];
  /** Choice under the pointer: highlighted, but not selected. */
  private hoverIndex: number | undefined;

  constructor(
    request: PendingApproval,
    onResponse: (response: ApprovalPanelResponse) => void,
    onToggleToolOutput?: () => void,
    onOpenPreview?: (block: DiffDisplayBlock | FileContentDisplayBlock) => void,
    options: ApprovalPanelOptions = {},
  ) {
    super(options.layout);
    this.request = request;
    this.onResponse = onResponse;
    this.onToggleToolOutput = onToggleToolOutput;
    this.onOpenPreview = onOpenPreview;
    this.isTerminalFocused = options.isTerminalFocused ?? (() => true);
    this.onFocusUpdates = options.onFocusUpdates;
    this.swallowNextCommit = options.wasTyping === true;
    this.feedbackInput.onSubmit = (value) => {
      this.submit(this.selectedIndex, value);
    };
    this.feedbackInput.onEscape = () => {
      this.feedbackMode = false;
      this.feedbackInput.setValue('');
    };
  }

  private submit(index: number, feedback: string = ''): void {
    const option = this.choiceAt(index);
    if (!option) return;
    this.onResponse({
      response: option.response,
      feedback: feedback || undefined,
      selected_label: option.selected_label,
    });
  }

  /**
   * Answer with a specific choice, entered from outside the panel.
   *
   * The status surface draws a folded one-line form of this approval and needs
   * to answer without expanding it. Routing through the panel (rather than
   * calling the response callback directly) keeps a single response path: a
   * choice that requires feedback still gets its inline input, instead of being
   * submitted blind.
   */
  selectChoice(choice: ApprovalPanelChoice): void {
    const index = this.request.data.choices.indexOf(choice);
    if (index < 0) return;
    this.selectAndSubmit(index);
  }

  /** Reject without feedback; the folded form's Esc path. */
  reject(): void {
    this.onResponse({ response: 'rejected' });
  }

  /**
   * The tool-specific prompt ("Run this command?", "Ready to build with this
   * plan?"). The folded one-line form shows this rather than a generic
   * "Approve <tool>?" so the user sees the same question in both shapes —
   * a second phrasing would be a second thing to keep in sync, and would drop
   * the wording each tool went to the trouble of providing.
   */
  headerText(): string {
    return headerFor(this.request.data.tool_name);
  }

  /** Number of choices, for callers laying out the numbered summary. */
  choiceCount(): number {
    return this.request.data.choices.length;
  }

  private selectAndSubmit(index: number): void {
    const option = this.choiceAt(index);
    if (!option) return;
    if (option.requires_feedback === true) {
      this.selectedIndex = index;
      this.feedbackMode = true;
    } else {
      this.submit(index);
    }
  }

  /**
   * The one place a keystroke, a shortcut or a click becomes an answer.
   *
   * When the prompt interrupted live typing, the first commit in the *approve*
   * direction is dropped: that keystroke was almost certainly aimed at the
   * message the user was writing, and the cost of guessing wrong is an approved
   * `rm -rf` against the cost of one extra Enter.
   *
   * Rejecting is never dropped — a rejected approval the user did mean costs the
   * agent a retry, while a swallowed one would look like an ignored keypress.
   * Feedback choices are not dropped either: they only open an input, which
   * commits nothing.
   */
  private selectAndSubmitGuarded(index: number): void {
    const option = this.choiceAt(index);
    if (!option) return;
    const isApprove = option.response === 'approved' || option.response === 'approved_for_session';
    if (this.swallowNextCommit && isApprove && option.requires_feedback !== true) {
      this.swallowNextCommit = false;
      return;
    }
    this.swallowNextCommit = false;
    this.selectAndSubmit(index);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
      this.onResponse({ response: 'rejected' });
      return;
    }

    if (matchesKey(data, Key.ctrl('e'))) {
      const previewable = this.findPreviewableBlock();
      if (previewable !== undefined && this.onOpenPreview !== undefined) {
        this.onOpenPreview(previewable);
      }
      return;
    }

    if (matchesKey(data, Key.ctrl('o'))) {
      this.onToggleToolOutput?.();
      return;
    }

    if (this.feedbackMode) {
      if (matchesKey(data, Key.up)) {
        this.feedbackMode = false;
        this.selectedIndex = (this.selectedIndex - 1 + this.choiceCount()) % this.choiceCount();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.feedbackMode = false;
        this.selectedIndex = (this.selectedIndex + 1) % this.choiceCount();
        return;
      }
      // Esc reaches feedbackInput.handleInput, whose onEscape exits feedback
      // mode — Esc must not reject the whole approval from inside the input.
      this.feedbackInput.handleInput(data);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.onResponse({ response: 'rejected' });
      return;
    }

    if (this.choiceCount() === 0) return;
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = (this.selectedIndex - 1 + this.choiceCount()) % this.choiceCount();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = (this.selectedIndex + 1) % this.choiceCount();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.selectAndSubmitGuarded(this.selectedIndex);
      return;
    }

    const printable = decodeKittyPrintable(data) ?? data;
    const numericIndex = Number(printable) - 1;
    if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < this.choiceCount()) {
      this.selectAndSubmitGuarded(numericIndex);
    }
  }

  /** Whether the inline feedback input owns the keyboard right now. */
  isTextEntryActive(): boolean {
    return this.feedbackMode;
  }

  /**
   * Handle a raw key handed up by the status surface.
   *
   * The surface routes normalized keys (`RegionKey`) to the region, which loses
   * the printable text a rejection reason is made of and the Ctrl shortcuts the
   * panel owns (`Ctrl+E` preview, `Ctrl+O` tool output) — neither has a
   * `RegionKey`. While the inline input is up it owns the keyboard outright;
   * otherwise only the Ctrl shortcuts are consumed and every other key falls
   * through so the editor's own binding still runs.
   */
  handleSurfaceInput(data: string): boolean {
    if (this.feedbackMode) {
      this.handleInput(data);
      return true;
    }
    if (
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d')) ||
      matchesKey(data, Key.ctrl('e')) ||
      matchesKey(data, Key.ctrl('o'))
    ) {
      this.handleInput(data);
      return true;
    }
    return false;
  }

  protected renderPart(part: DockPart, width: number): string[] {
    this.ensureValidSelection();
    this.feedbackInput.focused = this.focused && this.feedbackMode;
    const { data } = this.request;
    const blockStyles = makeBlockStyles();
    const selectColorBold = (text: string) => currentTheme.boldFg('accent', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const strong = (text: string) => currentTheme.fg('textStrong', text);
    const indent = (s: string): string => `  ${s}`;
    const fade = (text: string): string => (this.isTerminalFocused() ? text : currentTheme.fg('textDim', text));
    const clipped = (lines: string[]): string[] => lines.map((line) => truncateToWidth(line, width));

    const dedupedBlocks = data.display.filter(
      (block) => !isDuplicateBriefBlock(block, data.description),
    );
    const visibleBlocks = dedupedBlocks.slice(0, MAX_VISIBLE_BLOCKS);
    /**
     * Blocks the panel decided not to draw. Reported in the body rather than
     * dropped: an approval that silently shows five of seven changed files asks
     * the user to approve something they were never shown, which is the one
     * thing an approval prompt must not do.
     */
    const hiddenBlockCount = Math.max(0, dedupedBlocks.length - visibleBlocks.length);
    const hasPreviewable = dedupedBlocks.some(
      (block) => block.type === 'diff' || block.type === 'file_content',
    );

    if (part === 'head') {
      return clipped([
        fade(`  ${currentTheme.boldFg('borderFocus', '▶')} ${currentTheme.boldFg('borderFocus', headerFor(data.tool_name))}`),
      ]);
    }

    if (part === 'body') {
      const body: string[] = [];
      if (visibleBlocks.length > 0) {
        body.push('');
        for (const block of visibleBlocks) {
          const blockLines = renderDisplayBlock(block, blockStyles, Math.max(1, width - 6));
          for (const line of blockLines) body.push(indent(line));
        }
        if (hiddenBlockCount > 0) {
          body.push(
            indent(
              dim(
                t(
                  hiddenBlockCount === 1
                    ? 'tui.dialogs.approvalPanel.moreBlocksHidden_one'
                    : 'tui.dialogs.approvalPanel.moreBlocksHidden_other',
                  { count: hiddenBlockCount },
                ),
              ),
            ),
          );
        }
      } else if (data.description) {
        body.push('');
        for (const descLine of data.description.split('\n')) {
          body.push(indent(dim(descLine)));
        }
      }
      return clipped(body);
    }

    const foot: string[] = [''];
    const rows: number[] = [];
    for (let idx = 0; idx < data.choices.length; idx++) {
      const option = data.choices[idx];
      if (option === undefined) continue;
      const isSelected = idx === this.selectedIndex;
      const num = idx + 1;

      const labelWithNum = `${String(num)}. ${option.label}`;
      rows.push(foot.length);
      if (this.feedbackMode && option.requires_feedback === true && isSelected) {
        for (const feedbackLine of this.renderFeedbackLines(width - 6, labelWithNum)) {
          foot.push(indent(feedbackLine));
        }
      } else if (isSelected) {
        foot.push(indent(`${selectColorBold('▶')} ${selectColorBold(labelWithNum)}`));
      } else {
        foot.push(indent(strong(`  ${labelWithNum}`)));
      }

      if (
        option.description !== undefined &&
        option.description.length > 0 &&
        !(this.feedbackMode && option.requires_feedback === true && isSelected)
      ) {
        for (const descLine of wrapTextWithAnsi(option.description, Math.max(20, width - 11))) {
          foot.push(indent(`     ${dim(descLine)}`));
        }
      }
    }

    foot.push('');
    if (this.feedbackMode) {
      foot.push(indent(dim(t('tui.dialogs.approvalPanel.feedbackHint'))));
    } else if (data.choices.length === 0) {
      // The generic hint would read "↑/↓ select ·  choose · ↵ confirm" with no
      // choices to select or confirm, and the bare Esc-to-reject path was not
      // mentioned anywhere. Both are fixed by naming the only real action.
      foot.push(indent(dim(t('tui.dialogs.approvalPanel.navHintNoChoices'))));
    } else {
      const expandHint = hasPreviewable ? t('tui.dialogs.approvalPanel.expandHint') : '';
      const choiceCount = data.choices.length;
      const chooseHint =
        choiceCount > 9
          ? t('tui.dialogs.approvalPanel.navChooseRest', { digits: reachableDigits(choiceCount) })
          : t('tui.dialogs.approvalPanel.navChoose', { digits: reachableDigits(choiceCount) });
      foot.push(
        indent(
          dim(
            t('tui.dialogs.approvalPanel.navHint', {
              choose: chooseHint,
              expand: expandHint,
            }),
          ),
        ),
      );
    }
    this.choiceRows = rows;
    return clipped(foot);
  }

  protected override handlePartMouse(
    part: DockPart,
    event: TuiMouseEvent,
  ): TuiMouseEventResult | undefined {
    const index = part === 'foot' ? this.choiceRows.indexOf(event.y) : -1;
    if (event.type === 'move') {
      const hovered = index === -1 || this.feedbackMode || !this.focused ? undefined : index;
      if (hovered === this.hoverIndex) return index === -1 ? undefined : { handled: true };
      this.hoverIndex = hovered;
      return { handled: true, render: true };
    }
    if (event.button !== 'left') return undefined;
    if (event.type === 'click' && !this.focused) return { handled: true, focus: true };
    if (index === -1) return undefined;
    if (event.type === 'click' && !isSettlingClick(this.shownAt)) {
      this.clickChoice(index);
    }
    return { handled: true };
  }

  private clickChoice(index: number): void {
    if (!this.feedbackMode) {
      this.selectAndSubmitGuarded(index);
      return;
    }
    this.selectedIndex = index;
    this.feedbackMode = this.choiceAt(index)?.requires_feedback === true;
  }

  private findPreviewableBlock(): DiffDisplayBlock | FileContentDisplayBlock | undefined {
    for (const block of this.request.data.display) {
      if (block.type === 'diff' || block.type === 'file_content') return block;
    }
    return undefined;
  }

  private choiceAt(index: number): ApprovalPanelChoice | undefined {
    return this.request.data.choices[index];
  }

  private ensureValidSelection(): void {
    const count = this.choiceCount();
    if (count === 0) {
      this.selectedIndex = 0;
      return;
    }
    if (this.selectedIndex < 0 || this.selectedIndex >= count) {
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, count - 1));
    }
  }

  /**
   * The feedback input, inline after the choice label when there is room.
   *
   * Returns lines rather than one line because the inline form collapses: the
   * label alone can eat most of a narrow terminal, leaving an input a few
   * columns wide that shows a word or two of the reason the user is writing.
   * Below `minInputWidth` the input moves to its own line instead, which costs
   * one row and keeps the field usable.
   */
  private renderFeedbackLines(width: number, labelWithNum: string): string[] {
    const prefix = `${currentTheme.boldFg('accent', '▶')} ${currentTheme.boldFg('accent', labelWithNum)}  `;
    const inlineWidth = width - visibleWidth(prefix) + 2;
    if (inlineWidth >= MIN_INLINE_FEEDBACK_WIDTH) {
      return [prefix + this.feedbackBody(inlineWidth)];
    }
    const ownLineWidth = Math.max(MIN_INLINE_FEEDBACK_WIDTH, width - 2);
    return [prefix.trimEnd(), `  ${this.feedbackBody(ownLineWidth)}`];
  }

  /** The Input's text without its `> ` prompt and without the cursor marker. */
  private feedbackBody(inputWidth: number): string {
    const inputLine = this.feedbackInput.render(inputWidth)[0] ?? '> ';
    return inputLine.startsWith('> ') ? inputLine.slice(2) : inputLine;
  }

  override invalidate(): void {
    super.invalidate();
    this.feedbackInput.invalidate();
  }
}

/**
 * The choose hint that actually works, as a phrase ready for the template.
 *
 * Digits beyond 9 are unreachable — the panel reads one printable character per
 * keypress, so item 10 would need the two keys `1` and `0`, and `1` alone has
 * already picked item 1. The hint therefore stops at 9 and says where the rest
 * live, instead of advertising a count the keyboard cannot deliver.
 *
 * Returns the whole `1/2/3 choose` clause rather than just the digit list: the
 * template appends the word "choose" to it, and a suffix would leave the
 * 9-item case reading "1/…/9 · ↑/↓ for the rest choose".
 */
/** The digits the numeric shortcuts actually reach, for the nav hint. */
function reachableDigits(count: number): string {
  return Array.from({ length: Math.min(count, 9) }, (_, idx) => String(idx + 1)).join('/');
}
