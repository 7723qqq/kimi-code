/** @jsxImportSource @opentui/solid */
/**
 * TUI2 shell run card — live view for a user-initiated `!` shell command.
 *
 * Replaces `tui/components/messages/shell-run.ts`'s `ShellRunComponent` (a
 * pi-tui `Container` that owned its output buffer, a 1s timer, and an
 * imperative `requestRender`) with an opentui SolidJS view driven by a
 * `ShellRunState` snapshot. Two phases, mirroring v1:
 *
 *  - `running`: dim ANSI-stripped tail of the combined output (last
 *    {@link RUNNING_TAIL_LINES} lines), a `+N lines` overflow marker, an
 *    elapsed `(Xs)` timer that ticks every second, and a
 *    `(ctrl+b to run in background)` hint — matching claude-code's running
 *    card so warnings are grey rather than red while the command works.
 *  - `finished`: the `formatBashOutputForDisplay` view (stderr red only
 *    on failure) with the running chrome removed; `backgrounded` shows a
 *    single "moved to background" line.
 *
 * The view is stateless: the host owns the output buffer and writes
 * `run.combined` / `run.status` / `run.stdout|stderr` as it grows.
 * `appendShellRunOutput` caps the live buffer exactly like v1
 * (`MAX_COMBINED_CHARS` / `KEEP_COMBINED_CHARS`), and
 * `buildShellRunDisplay` is pure so the phases can be unit-tested.
 * The 1s elapsed tick is a component-local signal interval that stops
 * once the run leaves the `running` status.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createEffect, createSignal, For, onCleanup } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { t } from '#/i18n'
import { currentTheme, type ColorToken } from '../../theme'
import { formatBashOutputForDisplay, sanitizeShellOutput } from '../../utils/shell-output'

import { Box } from '../common/box'
import { Text } from '../common/text'

export const RUNNING_TAIL_LINES = 5
export const TIMER_INTERVAL_MS = 1000
// Cap the live running buffer so a command that spews output for minutes can't
// grow memory without bound or make every render re-strip a multi-MB string.
// Only affects the transient running tail; the final view uses the full
// captured stdout/stderr passed to the finished state.
export const MAX_COMBINED_CHARS = 256 * 1024
export const KEEP_COMBINED_CHARS = 64 * 1024

export type ShellRunStatus = 'running' | 'finished' | 'backgrounded'

/** Immutable snapshot of a `!` shell command's live card state. */
export interface ShellRunState {
  readonly startedAt: number
  readonly status: ShellRunStatus
  /** Combined live output (capped via `appendShellRunOutput`). */
  readonly combined: string
  /** Final captured stdout — valid once `status` is `finished`. */
  readonly stdout: string
  /** Final captured stderr — valid once `status` is `finished`. */
  readonly stderr: string
  readonly isError?: boolean
}

export interface ShellRunViewProps {
  readonly run: ShellRunState
}

export interface ShellRunDisplay {
  readonly lines: readonly string[]
  /** Color token for the finished view; undefined while running (all dim). */
  readonly color?: ColorToken
}

/** Append live output to the combined buffer, capping it as v1 did. */
export function appendShellRunOutput(combined: string, text: string): string {
  if (text.length === 0) return combined;
  const next = combined + text;
  if (next.length > MAX_COMBINED_CHARS) return next.slice(-KEEP_COMBINED_CHARS);
  return next;
}

/** Build the display lines for a run snapshot (pure — mirrors v1's `renderText`). */
export function buildShellRunDisplay(run: ShellRunState, elapsedSeconds: number): ShellRunDisplay {
  if (run.status === 'backgrounded') {
    return { lines: [t('tui.messages.shellRun.backgrounded')] };
  }
  if (run.status === 'finished') {
    const { text, color } = formatBashOutputForDisplay(run.stdout, run.stderr, run.isError);
    return { lines: text.split('\n'), color };
  }
  const trimmed = sanitizeShellOutput(run.combined).trimEnd();
  let body: readonly string[];
  let extra = 0;
  if (trimmed.length === 0) {
    body = [t('tui.messages.shellRun.running')];
  } else {
    const lines = trimmed.split('\n');
    const tail = lines.slice(-RUNNING_TAIL_LINES);
    extra = Math.max(0, lines.length - RUNNING_TAIL_LINES);
    body = tail;
  }
  const timing =
    extra > 0
      ? t('tui.messages.shellRun.timing', { extra, elapsed: elapsedSeconds })
      : t('tui.messages.shellRun.timingNoExtra', { elapsed: elapsedSeconds });
  return { lines: [...body, timing, t('tui.messages.shellRun.hint')] };
}

export const ShellRunView: Component<ShellRunViewProps> = (props) => {
  const [tick, setTick] = createSignal(Date.now());

  createEffect(() => {
    if (props.run.status !== 'running') return;
    const id = setInterval(() => setTick(Date.now()), TIMER_INTERVAL_MS);
    onCleanup(() => clearInterval(id));
  });

  const elapsed = (): number => Math.floor((tick() - props.run.startedAt) / 1000);
  const display = (): ShellRunDisplay => buildShellRunDisplay(props.run, elapsed());
  const fg = (): ColorInput => {
    const color = display().color;
    return color === undefined ? currentTheme.color('textDim') : currentTheme.color(color);
  };
  const attributes = (): number | undefined =>
    props.run.status === 'running' ? currentTheme.attributes('dim') : undefined;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <For each={display().lines}>
        {(line) => (
          <Text fg={fg()} attributes={attributes()} wrapMode="word">
            {line}
          </Text>
        )}
      </For>
    </Box>
  )
}
