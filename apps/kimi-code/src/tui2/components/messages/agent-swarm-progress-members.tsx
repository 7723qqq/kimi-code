/** @jsxImportSource @opentui/solid */
/**
 * TUI2 AgentSwarm member rows — compact per-member progress lines.
 *
 * The v1 module rendered a full pi-tui grid (braille bars, gradients, the
 * tick estimator). This tui2 view is the deliberately reduced counterpart:
 * one row per member (`icon name · phase · elapsed`) driven by the
 * store-published `agentSwarmData.members` summary, with rows beyond
 * `MAX_VISIBLE_SWARM_ROWS` collapsed into a "+N more" line. Elapsed time is
 * a plain `Date.now() - startedAt`, frozen at `endedAt` once the member
 * reaches a terminal state.
 *
 * Status: REAL (tui2). New file — v1 counterpart not ported wholesale.
 */

import type { Component } from 'solid-js'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { t } from '#/i18n'

import { MAX_VISIBLE_SWARM_ROWS, SWARM_ELAPSED_TICK_MS } from '../../constant/rendering'
import type { ColorToken } from '../../theme'
import { currentTheme } from '../../theme'
import type { AgentSwarmMemberData, AgentSwarmProgressData } from '../../types'

import { Box } from '../common/box'
import { Text } from '../common/text'

export function isTerminalSwarmStatus(status: AgentSwarmMemberData['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** Visible rows plus the count folded into the "+N more" line. */
export function visibleSwarmRows(
  members: readonly AgentSwarmMemberData[],
  max: number = MAX_VISIBLE_SWARM_ROWS,
): { rows: readonly AgentSwarmMemberData[]; hiddenCount: number } {
  return {
    rows: members.slice(0, max),
    hiddenCount: Math.max(0, members.length - max),
  };
}

function swarmStatusGlyph(status: AgentSwarmMemberData['status']): string {
  switch (status) {
    case 'running':
      return '\u25CF';
    case 'completed':
      return '\u2713';
    case 'failed':
      return '\u2717';
    case 'cancelled':
      return '\u2298';
    default:
      return '\u25CB';
  }
}

function swarmStatusColor(status: AgentSwarmMemberData['status']): ColorInput {
  const token: ColorToken =
    status === 'running'
      ? 'warning'
      : status === 'completed'
        ? 'success'
        : status === 'failed'
          ? 'error'
          : 'textDim';
  return currentTheme.color(token);
}

/** Simple elapsed label; terminal members freeze at their endedAt. */
export function formatSwarmElapsed(
  member: Pick<AgentSwarmMemberData, 'startedAt' | 'endedAt'>,
  nowMs: number,
): string | undefined {
  if (member.startedAt === undefined) return undefined;
  const ms = (member.endedAt ?? nowMs) - member.startedAt;
  if (ms < 1000) return '<1s';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}

export const AgentSwarmMembersView: Component<{ data: AgentSwarmProgressData }> = (props) => {
  const members = (): readonly AgentSwarmMemberData[] => props.data.members;
  const hasActiveMember = (): boolean =>
    props.data.status !== 'ended' && members().some((m) => !isTerminalSwarmStatus(m.status));

  // Elapsed seconds tick only while some member is still in flight; the
  // reconciler covers every data-driven change on its own.
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!hasActiveMember()) return;
    const id = setInterval(() => setNow(Date.now()), SWARM_ELAPSED_TICK_MS);
    onCleanup(() => clearInterval(id));
  });

  const visible = (): { rows: readonly AgentSwarmMemberData[]; hiddenCount: number } =>
    visibleSwarmRows(members());

  return (
    <Show when={members().length > 0}>
      <Box flexDirection="column" paddingLeft={2}>
        <For each={visible().rows}>{(member) => <SwarmMemberRow member={member} now={now()} />}</For>
        <Show when={visible().hiddenCount > 0}>
          <Text fg={currentTheme.color('textDim')}>
            {t('tui.chrome.workflowPanel.moreRuns', { count: visible().hiddenCount })}
          </Text>
        </Show>
      </Box>
    </Show>
  );
};

const SwarmMemberRow: Component<{ member: AgentSwarmMemberData; now: number }> = (props) => {
  const glyph = (): string => swarmStatusGlyph(props.member.status);
  const glyphColor = (): ColorInput => swarmStatusColor(props.member.status);
  const elapsed = (): string | undefined => formatSwarmElapsed(props.member, props.now);

  return (
    <Box flexDirection="row">
      <Text fg={glyphColor()}>{`${glyph()}`}</Text>
      <Text fg={currentTheme.color('text')}>{` ${props.member.name}`}</Text>
      <Show when={props.member.phase !== undefined && props.member.phase !== ''}>
        <Text fg={currentTheme.color('textMuted')}>
          {` \u00b7 ${props.member.phase}`}
        </Text>
      </Show>
      <Show when={elapsed() !== undefined}>
        <Text fg={currentTheme.color('textDim')}>{` \u00b7 ${elapsed()}`}</Text>
      </Show>
    </Box>
  );
};
