/**
 * AgentActivityViewer — full-screen detail view for a background agent task.
 *
 * Same full-screen skeleton as `TaskOutputViewer` (header / scrolling body /
 * footer, tail-follow), but the body is assembled from the in-memory
 * `SubagentActivityRecord` instead of the task's captured output: recent
 * steps with their assistant text (Markdown, same as the main transcript)
 * and tool calls rendered through the main-flow result renderers
 * (`pickResultRenderer` / `pickChip` / `extractKeyArgument`). `ToolCallComponent`
 * itself is not reused — it is a live, event-driven component, while this
 * view renders a snapshot.
 *
 * Ctrl+O toggles a global expand of every tool result (same semantics as the
 * main transcript's `toolOutputExpanded`), capped by what the store retained.
 */

import {
  Container,
  Key,
  matchesKey,
  type Focusable,
  type Terminal,
  truncateToWidth,
  visibleWidth,
} from '@moonshot-ai/pi-tui';
import type { BackgroundTaskInfo } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';
import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import type {
  SubagentActivityRecord,
  SubToolCallActivity,
} from '#/tui/controllers/subagent-activity-store';
import { currentTheme } from '#/tui/theme';
import type { ToolCallBlockData } from '#/tui/types';
import { printableChar } from '#/tui/utils/printable-key';
import { AssistantMessageComponent } from '../messages/assistant-message';
import { extractKeyArgument } from '../messages/tool-call';
import { pickChip } from '../messages/tool-renderers/chip';
import { pickResultRenderer } from '../messages/tool-renderers/registry';
import { statusColor, statusLabel } from './task-output-viewer';

const ELLIPSIS = '…';

export interface AgentActivityViewerProps {
  readonly taskId: string;
  readonly info: BackgroundTaskInfo | undefined;
  readonly record: SubagentActivityRecord | undefined;
  /** Session work dir, used to desensitize Read/Write/Edit paths in headers. */
  readonly workspaceDir?: string;
  readonly onClose: () => void;
}

function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w === width) return line;
  if (w > width) return truncateToWidth(line, width, ELLIPSIS);
  return line + ' '.repeat(width - w);
}

function fitExactly(line: string, width: number): string {
  let s = line;
  if (visibleWidth(s) > width) s = truncateToWidth(s, width, ELLIPSIS);
  return padToWidth(s, width);
}

export class AgentActivityViewer extends Container implements Focusable {
  focused = false;

  private props: AgentActivityViewerProps;
  private readonly terminal: Terminal;
  private expanded = false;
  /** Index of the topmost visible body line. */
  private scrollTop = 0;
  /** Stick to the bottom on updates until the user scrolls away. */
  private followTail = true;
  private lines: string[] = [];
  private lastCacheKey = '';

  constructor(props: AgentActivityViewerProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
  }

  setProps(next: AgentActivityViewerProps): void {
    const prev = this.props;
    this.props = next;
    // The styled body lines are cached against cacheKey() (width, expanded,
    // agentId, version) — only a record change may invalidate them. Header and
    // footer rebuild from props on every frame, and this viewer owns no child
    // components, so other prop changes need no invalidation at all. Clearing
    // the cache unconditionally here (as the invalidate() override must, for
    // theme switches) would defeat the version check: the tasks browser polls
    // once per second and every tick would rebuild all body Markdown.
    if (next.record !== prev.record || next.record?.version !== prev.record?.version) {
      this.lastCacheKey = '';
    }
    super.invalidate();
  }

  override invalidate(): void {
    // Theme switches arrive as a tree-wide invalidate; the styled body lines
    // are cached, so drop the cache here to pick up the new palette.
    this.lastCacheKey = '';
    super.invalidate();
  }

  // ── input ──────────────────────────────────────────────────────────

  handleInput(data: string): void {
    const visible = this.viewableRows();
    const k = printableChar(data);

    if (matchesKey(data, Key.escape) || k === 'q' || k === 'Q') {
      this.props.onClose();
      return;
    }
    if (matchesKey(data, Key.ctrl('o'))) {
      this.expanded = !this.expanded;
      this.lastCacheKey = '';
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.up) || k === 'k') {
      this.scrollBy(-1);
      return;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      this.scrollBy(1);
      return;
    }
    if (
      matchesKey(data, Key.pageUp) ||
      matchesKey(data, Key.ctrl('u')) ||
      k === ' ' ||
      data === '\u0002' /* C-b */
    ) {
      this.scrollBy(-Math.max(1, visible - 1));
      return;
    }
    if (
      matchesKey(data, Key.pageDown) ||
      matchesKey(data, Key.ctrl('d')) ||
      data === '\u0006' /* C-f */
    ) {
      this.scrollBy(Math.max(1, visible - 1));
      return;
    }
    if (matchesKey(data, Key.home) || k === 'g') {
      this.scrollTo(0);
      return;
    }
    if (matchesKey(data, Key.end) || k === 'G') {
      this.scrollTo(this.maxScroll());
      return;
    }
  }

  private scrollBy(delta: number): void {
    this.scrollTo(this.scrollTop + delta);
  }

  private scrollTo(target: number): void {
    this.scrollTop = Math.max(0, Math.min(target, this.maxScroll()));
    this.followTail = this.scrollTop >= this.maxScroll();
    this.invalidate();
  }

  private maxScroll(): number {
    return Math.max(0, this.lines.length - this.viewableRows());
  }

  /** Content rows inside the body frame: total rows minus header(1) +
   *  footer(1) + top border(1) + bottom border(1). */
  private viewableRows(): number {
    return Math.max(1, this.terminal.rows - 4);
  }

  // ── body assembly ──────────────────────────────────────────────────

  private cacheKey(innerWidth: number): string {
    const record = this.props.record;
    return [
      String(innerWidth),
      this.expanded ? 'x' : 'c',
      record?.agentId ?? '',
      String(record?.version ?? -1),
    ].join('|');
  }

  private buildLines(innerWidth: number): string[] {
    const record = this.props.record;
    if (record === undefined) {
      return [currentTheme.dim(`${MESSAGE_INDENT}${t('tui.dialogs.agentActivityViewer.noActivity')}`)];
    }

    const out: string[] = [];
    for (const step of record.steps) {
      out.push(currentTheme.dim(`── step ${String(step.step)} ──`));
      if (step.retrying !== undefined) {
        out.push(currentTheme.fg('warning', `${MESSAGE_INDENT}↻ ${step.retrying}`));
      }
      if (step.textTail.trim().length > 0) {
        const message = new AssistantMessageComponent();
        message.updateContent(step.textTail);
        out.push(...message.render(innerWidth));
      }
      for (const call of step.toolCalls) {
        out.push(this.buildToolCallHeader(call));
        out.push(...this.renderToolCallBody(call, innerWidth));
      }
      out.push('');
    }

    if (record.error !== undefined && record.error.length > 0) {
      out.push(currentTheme.fg('error', t('tui.dialogs.agentActivityViewer.failed')));
      const message = new AssistantMessageComponent();
      message.updateContent(record.error);
      out.push(...message.render(innerWidth));
    } else if (record.resultSummary !== undefined && record.resultSummary.length > 0) {
      out.push(currentTheme.boldFg('primary', t('tui.dialogs.agentActivityViewer.result')));
      const message = new AssistantMessageComponent();
      message.updateContent(record.resultSummary);
      out.push(...message.render(innerWidth));
    }

    if (out.length === 0) {
      out.push(currentTheme.dim(`${MESSAGE_INDENT}${t('tui.dialogs.agentActivityViewer.waiting')}`));
    }
    return out;
  }

  /** Same shape as the main flow's generic header (`tool-call.ts`
   *  `buildHeader`): bullet + verb + name + key argument + chip. Custom
   *  per-tool label wording (e.g. "Ran a command") is intentionally not
   *  mirrored — the per-tool *body* renderers carry the specialization. */
  private buildToolCallHeader(call: SubToolCallActivity): string {
    let bullet: string;
    if (call.status === 'error') {
      bullet = currentTheme.fg('error', '✗ ');
    } else if (call.status === 'done') {
      bullet = currentTheme.fg('success', STATUS_BULLET);
    } else {
      bullet = currentTheme.fg('text', STATUS_BULLET);
    }
    const verb =
      call.status === 'running'
        ? t('tui.dialogs.agentActivityViewer.using')
        : t('tui.dialogs.agentActivityViewer.used');
    const name = currentTheme.boldFg('primary', call.name);
    const keyArg = extractKeyArgument(call.name, call.args, this.props.workspaceDir);
    const argStr = keyArg === null || keyArg.length === 0 ? '' : currentTheme.dim(` (${keyArg})`);

    let chipStr = '';
    if (call.result !== undefined) {
      const provider = pickChip(call.name);
      const text = provider?.(this.toToolCallBlockData(call), call.result) ?? '';
      if (text.length > 0) {
        chipStr =
          call.result.is_error === true
            ? currentTheme.fg('error', ` · ${text}`)
            : currentTheme.dim(` · ${text}`);
      }
    }
    return `${bullet}${verb} ${name}${argStr}${chipStr}`;
  }

  private renderToolCallBody(call: SubToolCallActivity, innerWidth: number): string[] {
    if (call.result === undefined) {
      return call.liveOutputTail === undefined || call.liveOutputTail.length === 0
        ? []
        : [currentTheme.dim(`${MESSAGE_INDENT}│ ${sanitizeLiveOutput(call.liveOutputTail)}`)];
    }
    // The store caps retained output, which cannot survive as a parseable
    // media envelope (base64) — show a marker instead of dumping the blob.
    if (call.name === 'ReadMediaFile' && call.result.is_error !== true) {
      return [currentTheme.dim(`${MESSAGE_INDENT}${t('tui.dialogs.agentActivityViewer.mediaOutputOmitted')}`)];
    }
    const components = pickResultRenderer(call.name)(
      this.toToolCallBlockData(call),
      call.result,
      { expanded: this.expanded },
    );
    const out: string[] = [];
    for (const component of components) {
      out.push(...component.render(innerWidth));
    }
    return out;
  }

  private toToolCallBlockData(call: SubToolCallActivity): ToolCallBlockData {
    return { id: call.id, name: call.name, args: call.args };
  }

  // ── render ─────────────────────────────────────────────────────────

  override render(width: number): string[] {
    const rows = Math.max(3, this.terminal.rows);
    const bodyHeight = rows - 2;
    const innerWidth = Math.max(1, width - 4);

    const key = this.cacheKey(innerWidth);
    if (key !== this.lastCacheKey) {
      this.lines = this.buildLines(innerWidth);
      this.lastCacheKey = key;
    }
    if (this.followTail) this.scrollTop = this.maxScroll();

    const header = this.renderHeader(width);
    const body = this.renderBody(width, bodyHeight);
    const footer = this.renderFooter(width, bodyHeight);

    const out: string[] = [header];
    for (const line of body) out.push(line);
    out.push(footer);
    return out;
  }

  private renderHeader(width: number): string {
    const title = currentTheme.boldFg('primary', t('tui.dialogs.agentActivityViewer.title'));
    const record = this.props.record;
    const info = this.props.info;
    const segments: string[] = [];

    if (record !== undefined) {
      const label =
        record.description !== undefined && record.description.length > 0
          ? `${record.agentName} › ${record.description}`
          : record.agentName;
      segments.push(currentTheme.boldFg('text', label));
    } else {
      segments.push(currentTheme.boldFg('text', this.props.taskId));
    }
    if (info !== undefined) {
      segments.push(currentTheme.fg(statusColor(info.status), statusLabel(info.status)));
    }
    if (record !== undefined && record.steps.length > 0) {
      const from = record.steps[0]!.step;
      const to = record.steps.at(-1)!.step;
      let range = `step ${String(from)}–${String(to)} / ${String(record.totalSteps)}`;
      if (record.totalSteps > record.steps.length) {
        range += ` · ${t('tui.dialogs.agentActivityViewer.earlierStepsDiscarded')}`;
      }
      segments.push(currentTheme.fg('textMuted', range));
    }

    const composed = title + segments.join('  ');
    return fitExactly(composed, width);
  }

  private renderBody(width: number, bodyHeight: number): string[] {
    const innerWidth = Math.max(1, width - 4);

    const max = this.maxScroll();
    if (this.scrollTop > max) this.scrollTop = max;
    if (this.scrollTop < 0) this.scrollTop = 0;

    const viewRows = Math.max(1, bodyHeight - 2);
    const top = currentTheme.fg('primary', '┌' + '─'.repeat(Math.max(0, width - 2)) + '┐');
    const bottom = currentTheme.fg('primary', '└' + '─'.repeat(Math.max(0, width - 2)) + '┘');

    const out: string[] = [top];
    for (let i = 0; i < viewRows; i++) {
      const lineIndex = this.scrollTop + i;
      const raw = this.lines[lineIndex] ?? '';
      const inner = fitExactly(raw, innerWidth);
      out.push(currentTheme.fg('primary', '│ ') + inner + currentTheme.fg('primary', ' │'));
    }
    out.push(bottom);
    return out;
  }

  private renderFooter(width: number, bodyHeight: number): string {
    const key = (text: string): string => currentTheme.boldFg('primary', text);
    const dim = (text: string): string => currentTheme.fg('textMuted', text);

    const total = this.lines.length;
    const viewRows = Math.max(1, bodyHeight - 2);
    const maxScroll = Math.max(0, total - viewRows);
    const percent =
      maxScroll === 0 ? 100 : Math.round((this.scrollTop / maxScroll) * 100);
    const lineFrom = total === 0 ? 0 : this.scrollTop + 1;
    const lineTo = Math.min(total, this.scrollTop + viewRows);

    const position = currentTheme.fg(
      'textMuted',
      ` ${String(lineFrom)}-${String(lineTo)} / ${String(total)} (${String(percent)}%) `,
    );
    const keys =
      `${key('↑↓')} ${dim(t('tui.dialogs.agentActivityViewer.footer.line'))}  ` +
      `${key('PgUp/PgDn')} ${dim(t('tui.dialogs.agentActivityViewer.footer.page'))}  ` +
      `${key('g/G')} ${dim(t('tui.dialogs.agentActivityViewer.footer.topBottom'))}  ` +
      `${key('Ctrl+O')} ${dim(
        this.expanded
          ? t('tui.dialogs.agentActivityViewer.footer.collapse')
          : t('tui.dialogs.agentActivityViewer.footer.expand'),
      )}  ` +
      `${key('Q/Esc')} ${dim(t('tui.dialogs.agentActivityViewer.footer.cancel'))}`;
    const left = ` ${keys}`;
    const leftW = visibleWidth(left);
    const rightW = visibleWidth(position);
    if (leftW + 2 + rightW <= width) {
      return left + ' '.repeat(width - leftW - rightW) + position;
    }
    return fitExactly(left, width);
  }
}

/**
 * Strips terminal control sequences from subagent live output tails before
 * they enter the ANSI render stream. `liveOutputTail` is the raw last line of
 * a command's stdout/stderr, so a command can emit CSI cursor/color sequences
 * or OSC hyperlinks (progress bars, prompts, links) that would corrupt the
 * frame's color state or its layout. C0/C1 control characters (including lone
 * ESC) and CSI (`ESC [ … final`) / OSC (`ESC ] … BEL|ST`) sequences are
 * dropped; all other content is preserved verbatim.
 */
function sanitizeLiveOutput(value: string): string {
  let result = '';
  let i = 0;
  while (i < value.length) {
    const code = value.codePointAt(i)!;
    if (code === 0x1b) {
      const next = value.codePointAt(i + 1);
      if (next === 0x5b /* '[' */) {
        // CSI: ESC [ … final byte in 0x40–0x7e. Unterminated sequences are
        // consumed to the end of the string.
        i += 2;
        while (i < value.length && !(value.codePointAt(i)! >= 0x40 && value.codePointAt(i)! <= 0x7e)) {
          i += 1;
        }
        if (i < value.length) i += 1;
        continue;
      }
      if (next === 0x5d /* ']' */) {
        // OSC: ESC ] … terminated by BEL or ST (ESC \).
        i += 2;
        while (i < value.length) {
          const c = value.codePointAt(i);
          i += 1;
          if (c === 0x07) break;
          if (c === 0x1b && value.codePointAt(i) === 0x5c) {
            i += 1;
            break;
          }
        }
        continue;
      }
      // A lone ESC not opening a recognized sequence is a control char.
      i += 1;
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      i += 1;
      continue;
    }
    result += value[i]!;
    i += 1;
  }
  return result;
}

/**
 * Plain-text preview of a record for the tasks browser's Preview frame (the
 * frame styles whole lines itself, so this stays ANSI-free). The frame shows
 * the tail of the string, so the full retained activity is returned.
 */
export function formatSubagentActivityPreview(
  record: SubagentActivityRecord,
  workspaceDir?: string,
): string {
  const lines: string[] = [];
  for (const step of record.steps) {
    lines.push(`── step ${String(step.step)} ──`);
    if (step.retrying !== undefined) lines.push(`${MESSAGE_INDENT}↻ ${step.retrying}`);
    if (step.textTail.trim().length > 0) lines.push(...step.textTail.trimEnd().split('\n'));
    for (const call of step.toolCalls) {
      lines.push(formatPreviewToolCall(call, workspaceDir));
      if (
        call.result === undefined &&
        call.liveOutputTail !== undefined &&
        call.liveOutputTail.length > 0
      ) {
        lines.push(`${MESSAGE_INDENT}│ ${sanitizeLiveOutput(call.liveOutputTail)}`);
      }
    }
  }
  if (record.error !== undefined && record.error.length > 0) {
    lines.push(t('tui.dialogs.agentActivityViewer.failedColon'), ...record.error.trimEnd().split('\n'));
  } else if (record.resultSummary !== undefined && record.resultSummary.length > 0) {
    lines.push(
      t('tui.dialogs.agentActivityViewer.resultColon'),
      ...record.resultSummary.trimEnd().split('\n'),
    );
  }
  if (lines.length === 0) {
    return record.status === 'running' ? t('tui.dialogs.agentActivityViewer.waiting') : '';
  }
  return lines.join('\n');
}

function formatPreviewToolCall(call: SubToolCallActivity, workspaceDir?: string): string {
  const mark = call.status === 'done' ? '✓' : call.status === 'error' ? '✗' : '●';
  const verb =
    call.status === 'running'
      ? t('tui.dialogs.agentActivityViewer.using')
      : t('tui.dialogs.agentActivityViewer.used');
  const keyArg = extractKeyArgument(call.name, call.args, workspaceDir);
  const argStr = keyArg === null || keyArg.length === 0 ? '' : ` (${keyArg})`;

  let chip = '';
  if (call.result !== undefined) {
    const callData: ToolCallBlockData = { id: call.id, name: call.name, args: call.args };
    const text = pickChip(call.name)?.(callData, call.result) ?? '';
    if (text.length > 0) chip = ` · ${text}`;
  }
  return `${mark} ${verb} ${call.name}${argStr}${chip}`;
}
