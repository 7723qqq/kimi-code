/**
 * ApprovalPanel — pi-tui version of the approval request UI.
 *
 * Container-based component with keyboard navigation.
 */

import {
  Container,
  Input,
  matchesKey,
  Key,
  decodeKittyPrintable,
  type Focusable,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
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

export class ApprovalPanelComponent extends Container implements Focusable {
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

  constructor(
    request: PendingApproval,
    onResponse: (response: ApprovalPanelResponse) => void,
    onToggleToolOutput?: () => void,
    onOpenPreview?: (block: DiffDisplayBlock | FileContentDisplayBlock) => void,
  ) {
    super();
    this.request = request;
    this.onResponse = onResponse;
    this.onToggleToolOutput = onToggleToolOutput;
    this.onOpenPreview = onOpenPreview;
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
      this.selectAndSubmit(this.selectedIndex);
      return;
    }

    const printable = decodeKittyPrintable(data) ?? data;
    const numericIndex = Number(printable) - 1;
    if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < this.choiceCount()) {
      this.selectAndSubmit(numericIndex);
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

  override render(width: number): string[] {
    this.clear();
    this.ensureValidSelection();
    this.feedbackInput.focused = this.focused && this.feedbackMode;
    const { data } = this.request;
    const blockStyles = makeBlockStyles();
    const selectColorBold = (text: string) => currentTheme.boldFg('accent', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const strong = (text: string) => currentTheme.fg('textStrong', text);
    const indent = (s: string): string => `  ${s}`;

    // Body rows live inside the shared frame: its borders and inner padding
    // cost four columns, so the wrap widths below are the panel's own 2-space
    // indent plus that overhead narrower than the render width.
    const body: string[] = [];

    const dedupedBlocks = data.display.filter(
      (block) => !isDuplicateBriefBlock(block, data.description),
    );
    const visibleBlocks = dedupedBlocks.slice(0, 5);
    const hasPreviewable = visibleBlocks.some(
      (block) => block.type === 'diff' || block.type === 'file_content',
    );

    if (visibleBlocks.length > 0) {
      body.push('');
      for (const block of visibleBlocks) {
        const blockLines = renderDisplayBlock(block, blockStyles, Math.max(1, width - 6));
        for (const line of blockLines) {
          body.push(indent(line));
        }
      }
    } else if (data.description) {
      body.push('');
      for (const descLine of data.description.split('\n')) {
        body.push(indent(dim(descLine)));
      }
    }

    body.push('');
    for (let idx = 0; idx < data.choices.length; idx++) {
      const option = data.choices[idx];
      if (option === undefined) continue;
      const isSelected = idx === this.selectedIndex;
      const num = idx + 1;

      const labelWithNum = `${String(num)}. ${option.label}`;
      if (this.feedbackMode && option.requires_feedback === true && isSelected) {
        body.push(indent(this.renderInlineFeedbackLine(width - 6, labelWithNum)));
      } else if (isSelected) {
        body.push(indent(`${selectColorBold('▶')} ${selectColorBold(labelWithNum)}`));
      } else {
        body.push(indent(strong(`  ${labelWithNum}`)));
      }

      // Optional helper text under the label, aligned past the pointer/number.
      // Choices without a description render exactly as before.
      if (
        option.description !== undefined &&
        option.description.length > 0 &&
        !(this.feedbackMode && option.requires_feedback === true && isSelected)
      ) {
        for (const descLine of wrapTextWithAnsi(option.description, Math.max(20, width - 11))) {
          body.push(indent(`     ${dim(descLine)}`));
        }
      }
    }

    body.push('');
    if (this.feedbackMode) {
      body.push(indent(dim(t('tui.dialogs.approvalPanel.feedbackHint'))));
    } else {
      const expandHint = hasPreviewable ? t('tui.dialogs.approvalPanel.expandHint') : '';
      body.push(
        indent(
          dim(
            t('tui.dialogs.approvalPanel.navHint', {
              numeric: buildNumericHint(data.choices.length),
              expand: expandHint,
            }),
          ),
        ),
      );
    }

    // The strip's frame belongs to the status surface, so the panel draws the
    // body only. The tool-specific question heads the region's summary row,
    // which stays visible in both fold states.
    return body.map((line) => truncateToWidth(line, width));
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

  private renderInlineFeedbackLine(width: number, labelWithNum: string): string {
    const prefix = `${currentTheme.boldFg('accent', '▶')} ${currentTheme.boldFg('accent', labelWithNum)}  `;
    const inputWidth = Math.max(4, width - visibleWidth(prefix) + 2);
    const inputLine = this.feedbackInput.render(inputWidth)[0] ?? '> ';
    const inlineInput = inputLine.startsWith('> ') ? inputLine.slice(2) : inputLine;
    return prefix + inlineInput;
  }

  override invalidate(): void {
    super.invalidate();
    this.feedbackInput.invalidate();
  }
}

function buildNumericHint(count: number): string {
  if (count <= 0) return '↵';
  return Array.from({ length: Math.min(count, 9) }, (_, idx) => String(idx + 1)).join('/');
}
