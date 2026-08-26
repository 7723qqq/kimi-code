/** @jsxImportSource @opentui/solid */
/**
 * TUI2 btw-panel — side-question ("by the way…") conversation view shown
 * in the right pane alongside the main transcript.
 *
 * Replaces the v1 `BtwPanelComponent` (tui/panes/btw-panel.ts). The panel
 * is a pure view over `store.state.btwPanel`: the controller accumulates
 * `answer` / `thinking`, records failures in `failed`, surfaces busy
 * notices in `transientNotice`, and tracks ↑/↓ scrolling in
 * `scrollOffset`; this component renders whatever the slice holds.
 *
 * Rendering mirrors v1's contract: the finished answer renders as
 * markdown (`MarkdownContentView`), pending thinking shows as a dim
 * tail, errors render in the error color, and the body height is capped
 * at a third of the terminal (v1 `collapsedBodyLimit`). While the user
 * has scrolled back (`scrollOffset > 0`) the body switches to a windowed
 * plain-line projection so earlier lines stay reachable without layout
 * information about the markdown run.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { For, Show } from 'solid-js'

import { t } from '#/i18n'

import { THINKING_PREVIEW_LINES } from '../../constant/rendering'
import { useTui2Store } from '../../state'
import { currentTheme } from '../../theme'
import type { ColorInput } from '@opentui/core'

import { Box } from '../common/box'
import { Text } from '../common/text'
import { MarkdownContentView } from '../messages/markdown-content'

/** Minimum body lines kept when the terminal height caps the panel (v1 parity). */
const MIN_COLLAPSED_PANEL_LINES = 3;
/** Chrome rows around the body (top border row + bottom border row). */
const PANEL_CHROME_LINES = 2;
/** Body cell budget: pane width minus the `│ ` / ` │` gutters, with slack. */
const BODY_GUTTER_CELLS = 4;

export interface BtwPanelProps {
  readonly width: number
}

/** One plain body line in the scrolled-back projection. */
export interface BtwBodyLine {
  readonly text: string
  readonly kind: 'answer' | 'thinking' | 'error' | 'notice' | 'waiting'
}

/**
 * Body-line cap for a terminal of `terminalRows` rows — mirrors v1's
 * `collapsedBodyLimit`: a third of the terminal for the whole panel,
 * minus chrome. `undefined` when the height is unknown (uncapped).
 */
export function btwBodyLineLimit(terminalRows: number | undefined): number | undefined {
  if (terminalRows === undefined || !Number.isFinite(terminalRows) || terminalRows <= 0) {
    return undefined;
  }
  const maxPanelLines = Math.max(MIN_COLLAPSED_PANEL_LINES, Math.floor(terminalRows / 3));
  return Math.max(1, maxPanelLines - PANEL_CHROME_LINES);
}

/** Hard-wrap one segment into single-cell chunks of at most `width` cells. */
export function wrapPlainLines(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const chunks: string[] = [];
  let current = '';
  for (const char of text) {
    if (current.length >= safeWidth) {
      chunks.push(current);
      current = '';
    }
    current += char;
  }
  chunks.push(current);
  return chunks;
}

function pushWrapped(lines: BtwBodyLine[], text: string, width: number, kind: BtwBodyLine['kind']): void {
  for (const segment of text.split('\n')) {
    for (const chunk of wrapPlainLines(segment, width)) {
      lines.push({ text: chunk, kind });
    }
  }
}

/**
 * Plain-line projection of the whole body used by the scrolled-back view:
 * answer source (wrapped), thinking tail or waiting marker, failure, and
 * transient notice — top to bottom, mirroring the structured sections.
 */
export function buildBtwPlainBody(panel: {
  readonly answer: string;
  readonly thinking: string;
  readonly running: boolean;
  readonly failed: string | null;
  readonly transientNotice: string | null;
}, width: number): readonly BtwBodyLine[] {
  const lines: BtwBodyLine[] = [];
  const answer = panel.answer.trim();
  if (answer.length > 0) {
    pushWrapped(lines, answer, Math.max(1, width - BODY_GUTTER_CELLS), 'answer');
  } else {
    const trimmedThinking = panel.thinking.trim();
    if (trimmedThinking.length > 0) {
      const all = trimmedThinking.split('\n');
      const tail =
        all.length > THINKING_PREVIEW_LINES ? all.slice(-THINKING_PREVIEW_LINES) : all;
      for (const line of tail) {
        lines.push({ text: line, kind: 'thinking' });
      }
    } else if (panel.running && panel.failed === null) {
      lines.push({ text: t('tui.dialogs.btwPanel.waitingForAnswer'), kind: 'waiting' });
    }
  }
  if (panel.failed !== null && panel.failed.length > 0) {
    pushWrapped(lines, panel.failed, Math.max(1, width - BODY_GUTTER_CELLS), 'error');
  }
  if (panel.transientNotice !== null && panel.transientNotice.length > 0) {
    lines.push({ text: panel.transientNotice, kind: 'notice' });
  }
  return lines;
}

/**
 * Window the body lines for display: offset 0 follows the tail (last
 * `limit` lines), a positive offset scrolls back toward the top.
 * `hiddenAbove` counts lines clipped above the window (scroll indicator).
 */
export function btwScrollWindow(
  lines: readonly BtwBodyLine[],
  limit: number | undefined,
  offset: number,
): { readonly visible: readonly BtwBodyLine[]; readonly hiddenAbove: number } {
  if (limit === undefined || lines.length <= limit) {
    return { visible: lines, hiddenAbove: 0 };
  }
  const tailStart = lines.length - limit;
  const start = Math.max(0, tailStart - Math.max(0, offset));
  return { visible: lines.slice(start, start + limit), hiddenAbove: start };
}

const readTerminalRows = (): number | undefined => {
  const rows = process.stdout.rows;
  return typeof rows === 'number' && Number.isFinite(rows) ? rows : undefined;
};

export const BtwPanel: Component<BtwPanelProps> = (props) => {
  const store = useTui2Store()
  const panel = () => store.state.btwPanel

  const borderFg = (): ColorInput => currentTheme.color('border')
  const accentFg = (): ColorInput => currentTheme.color('accent')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const textDimFg = (): ColorInput => currentTheme.color('textDim')
  const errorFg = (): ColorInput => currentTheme.color('error')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')

  const scrolledBack = (): boolean => panel().scrollOffset > 0;

  const hint = (): string =>
    scrolledBack() ? t('tui.dialogs.btwPanel.scrollHint') : t('tui.dialogs.btwPanel.closeHint');

  /** Thinking preview lines (dim), shown only while there is no answer yet. */
  const thinkingLines = (): string[] => {
    const trimmed = panel().thinking.trim();
    if (trimmed.length === 0 || panel().answer.trim().length > 0) return [];
    const all = trimmed.split('\n');
    return all.length > THINKING_PREVIEW_LINES ? all.slice(-THINKING_PREVIEW_LINES) : all;
  };

  const bodyEmpty = (): boolean => {
    const p = panel();
    return (
      p.answer.trim().length === 0 &&
      p.thinking.trim().length === 0 &&
      (p.failed === null || p.failed.length === 0) &&
      (p.transientNotice === null || p.transientNotice.length === 0)
    );
  };

  const bodyLineFg = (kind: BtwBodyLine['kind']): ColorInput => {
    switch (kind) {
      case 'error':
        return errorFg();
      case 'answer':
        return currentTheme.color('text');
      default:
        return textDimFg();
    }
  };

  return (
    <Box flexDirection="column">
      {/* Top border with title + scroll/close hint */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'╭─ '}</Text>
        <Text fg={accentFg()} attributes={titleAttrs()}>{t('tui.dialogs.btwPanel.title')}</Text>
        <Text fg={textDimFg()}>{hint()}</Text>
      </Box>

      <Show
        when={!bodyEmpty()}
        fallback={
          <Box>
            <Text>{'│ '}</Text>
            <Text fg={textMutedFg()}>{t('tui.dialogs.btwPanel.readyForSideQuestion')}</Text>
          </Box>
        }
      >
        <Show
          when={scrolledBack()}
          fallback={
            // Tail-follow view: markdown answer + structured sections,
            // anchored to the bottom of the capped body so streaming
            // growth stays visible (overflow clips above).
            <Box
              flexDirection="column"
              justifyContent="flex-end"
              maxHeight={btwBodyLineLimit(readTerminalRows())}
            >
              <For each={thinkingLines()}>
                {(line) => (
                  <Box>
                    <Text>{'│ '}</Text>
                    <Text fg={textDimFg()}>{line}</Text>
                  </Box>
                )}
              </For>
              <Show when={panel().answer.trim().length > 0}>
                <Box>
                  <Text>{'│ '}</Text>
                  <MarkdownContentView content={panel().answer.trim()} />
                </Box>
              </Show>
              <Show when={(panel().failed ?? '').length > 0}>
                <For each={(panel().failed ?? '').split('\n')}>
                  {(line) => (
                    <Box>
                      <Text>{'│ '}</Text>
                      <Text fg={errorFg()}>{line}</Text>
                    </Box>
                  )}
                </For>
              </Show>
              <Show when={(panel().transientNotice ?? '').length > 0}>
                <Box>
                  <Text>{'│ '}</Text>
                  <Text fg={textDimFg()}>{panel().transientNotice ?? ''}</Text>
                </Box>
              </Show>
            </Box>
          }
        >
          {/* Scrolled-back view: deterministic plain-line window. */}
          <For
            each={
              btwScrollWindow(
                buildBtwPlainBody(panel(), props.width),
                btwBodyLineLimit(readTerminalRows()),
                panel().scrollOffset,
              ).visible
            }
          >
            {(line) => (
              <Box>
                <Text>{'│ '}</Text>
                <Text fg={bodyLineFg(line.kind)}>{line.text}</Text>
              </Box>
            )}
          </For>
        </Show>
      </Show>

      {/* Bottom border */}
      <Box>
        <Text fg={borderFg()}>{`╰${'─'.repeat(Math.max(0, props.width - 2))}╯`}</Text>
      </Box>
    </Box>
  )
}
