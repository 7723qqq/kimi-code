/** @jsxImportSource @opentui/solid */
/**
 * TUI2 shell execution card — command preview + result preview.
 *
 * Replaces `tui/components/messages/shell-execution.ts`'s
 * `ShellExecutionComponent` (a pi-tui `Container`) with an opentui
 * SolidJS view. Two stacked previews:
 *
 *   $ pnpm build          ← command, `$` in shellMode, body dim
 *     pnpm --filter app   ← continuation lines dim, two-cell indent
 *   <result output>       ← result preview (textMuted, error on failure)
 *   (+N more lines, ctrl+o to expand)
 *
 * Clicking the command preview fires `onCopyCommand` (mirrors v1's
 * `handleClick`). Truncation caps *logical* lines — v1 capped visual
 * wrapped rows via pi-tui's `Text.render(width)`, which the opentui
 * layout tree does not expose synchronously; the layout engine wraps the
 * remaining content instead. `trimTrailingEmptyLines` /
 * `buildTruncatedOutputLines` stay pure for unit tests.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component, JSX } from 'solid-js'
import { createMemo, For, Show } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { t } from '#/i18n'
import { RESULT_PREVIEW_LINES } from '../../constant/rendering'
import { currentTheme } from '../../theme'
import type { ToolCallBlockData, ToolResultBlockData } from '../../types'

import { Box } from '../common/box'
import { Clickable } from '../common/clickable'
import { Text } from '../common/text'

export interface ShellExecutionOptions {
  readonly command?: string
  readonly result?: ToolResultBlockData
  readonly expanded?: boolean
  readonly showCommand?: boolean
  /**
   * Max command lines to render. `undefined` means no cap — used by the
   * ctrl+o expanded view so the user can see the full multi-line command
   * even when the header preview was truncated.
   */
  readonly commandPreviewLines?: number
  readonly resultPreviewLines?: number
  readonly tailOutput?: boolean
  readonly expandHint?: boolean
  /** Fired when the command preview is clicked (host copies it). */
  readonly onCopyCommand?: (command: string) => void
}

/** Drop trailing empty lines (verbatim from v1's truncated renderer). */
export function trimTrailingEmptyLines(lines: readonly string[]): string[] {
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1];
    if (line === undefined || line.length > 0) break;
    end--;
  }
  return lines.slice(0, end);
}

export interface TruncatedOutputLines {
  readonly lines: readonly string[]
  /** Truncation footer when the output exceeds `maxLines`; undefined otherwise. */
  readonly hint: string | undefined
}

/**
 * Cap output at `maxLines` logical lines (head or tail), with the same
 * hint copy as v1's `TruncatedOutputComponent`.
 */
export function buildTruncatedOutputLines(
  output: string,
  options: { maxLines: number; tail: boolean; expandHint: boolean },
): TruncatedOutputLines {
  const cleaned = trimTrailingEmptyLines(output.split('\n'));
  if (cleaned.length <= options.maxLines) {
    return { lines: cleaned, hint: undefined };
  }
  const remaining = cleaned.length - options.maxLines;
  const hint = options.tail
    ? t('tui.statusMessages.truncatedEarlierLines', { remaining: String(remaining) })
    : options.expandHint
      ? t('tui.statusMessages.truncatedMoreLinesExpandable', { remaining: String(remaining) })
      : t('tui.statusMessages.truncatedMoreLines', { remaining: String(remaining) });
  const lines = options.tail ? cleaned.slice(-options.maxLines) : cleaned.slice(0, options.maxLines);
  return { lines, hint };
}

export const ShellExecutionView: Component<ShellExecutionOptions> = (props) => {
  const commandLines = (): readonly string[] => {
    if (props.command === undefined || props.command.length === 0) return [];
    const all = props.command.split('\n');
    return props.commandPreviewLines === undefined ? all : all.slice(0, props.commandPreviewLines);
  };

  /** Memoized: the JSX reads `resultPreview()` three times per render; each
   *  unmemoized call split the full output string anew. */
  const resultPreview = createMemo<TruncatedOutputLines | undefined>(() => {
    const result = props.result;
    if (result === undefined || result.output.length === 0) return undefined;
    if (props.expanded === true) {
      return { lines: trimTrailingEmptyLines(result.output.split('\n')), hint: undefined };
    }
    return buildTruncatedOutputLines(result.output, {
      maxLines: props.resultPreviewLines ?? RESULT_PREVIEW_LINES,
      tail: props.tailOutput ?? false,
      expandHint: props.expandHint ?? true,
    });
  });

  const resultFg = (): ColorInput =>
    props.result?.is_error === true ? currentTheme.color('error') : currentTheme.color('textMuted')

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Show when={props.showCommand === true && commandLines().length > 0}>
        <Clickable
          onClick={() => {
            if (props.command !== undefined && props.command.length > 0) {
              props.onCopyCommand?.(props.command);
            }
          }}
        >
          <Box flexDirection="column">
            <For each={commandLines()}>
              {(line, i) =>
                i() === 0 ? (
                  <Box flexDirection="row">
                    <Text fg={currentTheme.color('shellMode')}>{'$ '}</Text>
                    <Text fg={currentTheme.color('textDim')} attributes={currentTheme.attributes('dim')} wrapMode="word">
                      {line}
                    </Text>
                  </Box>
                ) : (
                  <Text fg={currentTheme.color('textDim')} attributes={currentTheme.attributes('dim')} wrapMode="word">
                    {`  ${line}`}
                  </Text>
                )
              }
            </For>
          </Box>
        </Clickable>
      </Show>
      <Show when={resultPreview() !== undefined}>
        <Box flexDirection="column">
          <For each={resultPreview()?.lines ?? []}>
            {(line) => (
              <Text fg={resultFg()} wrapMode="word">
                {line}
              </Text>
            )}
          </For>
          <Show when={resultPreview()?.hint !== undefined}>
            <Text fg={currentTheme.color('textDim')} attributes={currentTheme.attributes('dim')} wrapMode="word">
              {resultPreview()?.hint}
            </Text>
          </Show>
        </Box>
      </Show>
    </Box>
  )
}

/**
 * Result-only renderer for the tool-call registry: the command preview is
 * owned by the tool-call header across the whole lifecycle (streaming,
 * running, and done), so this renders the result block alone — mirroring
 * v1's `shellExecutionResultRenderer`.
 */
export function shellExecutionResultRenderer(
  _toolCall: ToolCallBlockData,
  result: ToolResultBlockData,
  ctx: { readonly expanded: boolean },
): JSX.Element {
  return <ShellExecutionView result={result} expanded={ctx.expanded} />
}
