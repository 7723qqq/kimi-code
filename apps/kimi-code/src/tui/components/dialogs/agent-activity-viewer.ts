/**
 * AgentActivityViewer — renders a background agent task's in-memory activity
 * record as embeddable content lines.
 *
 * The record is assembled from the `SubagentActivityRecord` the session event
 * handler keeps: recent steps with their assistant text (Markdown, same as the
 * main transcript) and tool calls rendered through the main-flow result
 * renderers (`pickResultRenderer` / `pickChip` / `extractKeyArgument`).
 * `ToolCallComponent` itself is not reused — it is a live, event-driven
 * component, while this renders a snapshot.
 *
 * The viewer is embedded in the tasks panel rather than owning a screen of
 * its own: it takes an explicit height and returns exactly that many lines,
 * so the panel decides how much room the activity gets.
 */

import { t } from '#/i18n';
import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import type {
  SubagentActivityRecord,
  SubToolCallActivity,
} from '#/tui/controllers/subagent-activity-store';
import { currentTheme } from '#/tui/theme';
import type { ToolCallBlockData } from '#/tui/types';

import { AssistantMessageComponent } from '../messages/assistant-message';
import { extractKeyArgument } from '../messages/tool-call';
import { pickChip } from '../messages/tool-renderers/chip';
import { parseReadMediaOutput } from '../messages/tool-renderers/media';
import { pickResultRenderer } from '../messages/tool-renderers/registry';

export interface AgentActivityViewerProps {
  /** The activity record, or undefined when the session holds none. */
  readonly record: SubagentActivityRecord | undefined;
  /** Session work dir, used to desensitize Read/Write/Edit paths. */
  readonly workspaceDir?: string | undefined;
  /** Expand every tool result (mirrors the transcript's global expand). */
  readonly expanded: boolean;
}

export class AgentActivityViewer {
  private props: AgentActivityViewerProps;
  private lines: string[] = [];
  private lastCacheKey = '';

  constructor(props: AgentActivityViewerProps) {
    this.props = props;
  }

  setProps(next: AgentActivityViewerProps): void {
    const prev = this.props;
    this.props = next;
    // The styled body lines are cached against cacheKey() (width, expanded,
    // agentId, version) — only a record change may invalidate them. The tasks
    // panel polls once per second and every tick would otherwise rebuild all
    // body Markdown.
    if (
      next.record !== prev.record ||
      next.record?.version !== prev.record?.version ||
      next.expanded !== prev.expanded ||
      next.workspaceDir !== prev.workspaceDir
    ) {
      this.lastCacheKey = '';
    }
  }

  /**
   * The activity as `height` lines: a header line with the agent label and
   * step range, then the tail of the body. The tail is what the user cares
   * about — the earliest steps are the least relevant once an agent has run
   * for a while.
   */
  renderLines(width: number, height: number): string[] {
    if (height <= 0) return [];
    const innerWidth = Math.max(1, width);
    const key = this.cacheKey(innerWidth);
    if (key !== this.lastCacheKey) {
      this.lines = this.buildLines(innerWidth);
      this.lastCacheKey = key;
    }
    const header = this.buildHeader();
    const body = this.lines.slice(Math.max(0, this.lines.length - (height - 1)));
    const out = [header, ...body];
    while (out.length < height) out.push('');
    return out.slice(0, height);
  }

  private cacheKey(innerWidth: number): string {
    const record = this.props.record;
    return [
      String(innerWidth),
      this.props.expanded ? 'x' : 'c',
      record?.agentId ?? '',
      String(record?.version ?? -1),
    ].join('|');
  }

  private buildHeader(): string {
    const record = this.props.record;
    if (record === undefined) {
      return currentTheme.fg('textMuted', '—');
    }
    const label =
      record.description !== undefined && record.description.length > 0
        ? `${record.agentName} › ${record.description}`
        : record.agentName;
    const parts = [currentTheme.boldFg('text', label)];
    if (record.steps.length > 0) {
      const from = record.steps[0]!.step;
      const to = record.steps.at(-1)!.step;
      parts.push(currentTheme.fg('textMuted', `step ${String(from)}–${String(to)}`));
    }
    return parts.join(' · ');
  }

  private buildLines(innerWidth: number): string[] {
    const record = this.props.record;
    if (record === undefined) {
      return [];
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
    const isMediaResult =
      call.name === 'ReadMediaFile' ||
      (call.name === 'Read' &&
        call.result.output.startsWith('[') &&
        parseReadMediaOutput(call.result.output) !== null);
    if (isMediaResult && call.result.is_error !== true) {
      return [
        currentTheme.dim(
          `${MESSAGE_INDENT}${t('tui.dialogs.agentActivityViewer.mediaOutputOmitted')}`,
        ),
      ];
    }
    const components = pickResultRenderer(call.name)(this.toToolCallBlockData(call), call.result, {
      expanded: this.props.expanded,
    });
    const out: string[] = [];
    for (const component of components) {
      out.push(...component.render(innerWidth));
    }
    return out;
  }

  private toToolCallBlockData(call: SubToolCallActivity): ToolCallBlockData {
    return { id: call.id, name: call.name, args: call.args };
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
        while (
          i < value.length &&
          !(value.codePointAt(i)! >= 0x40 && value.codePointAt(i)! <= 0x7e)
        ) {
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
