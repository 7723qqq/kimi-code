/** @jsxImportSource @opentui/solid */
/**
 * TUI2 workflow panel — live status panel for running workflow runs.
 *
 * Replaces `tui/components/chrome/workflow-panel.ts`'s
 * `WorkflowPanelComponent` (a pi-tui `Component` with imperative
 * `setRuns` / `requestRender`) with an opentui SolidJS view that reads
 * `store.state.workflowRuns` — the tui2 workflow controller
 * (`tui2/controllers/workflow-panel.ts`) writes that slice and the
 * reconciler re-renders the panel automatically. State survives across
 * turns so the panel stays visible until the workflow finishes.
 *
 * Each run is rendered as a compact row with:
 *   ⚡ deep-research (wf_3)  ●  Plan  ✓  2agents
 *
 * The status icon tracks the run's lifecycle:
 *   ● (amber)  →  running
 *   ✓ (green)  →  completed
 *   ✗ (red)    →  failed
 *   ⊘ (dim)    →  cancelled
 *
 * Clicking the panel toggles expansion (local signal; the store has no
 * workflow-panel expansion slice).
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal, For, Show } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { t } from '#/i18n'
import { useTui2Store } from '../../state'
import { currentTheme } from '../../theme'
import { MAX_VISIBLE_RUNS, type WorkflowRunData, type WorkflowStatus } from '../../types'

import { Box } from '../common/box'
import { Clickable } from '../common/clickable'
import { Text } from '../common/text'

export { MAX_VISIBLE_RUNS }
export type { WorkflowRunData, WorkflowStatus }

export const WorkflowPanelView: Component = () => {
  const store = useTui2Store()
  const [expanded, setExpanded] = createSignal(false)

  const runs = (): readonly WorkflowRunData[] => store.state.workflowRuns
  const visible = (): readonly WorkflowRunData[] =>
    expanded() ? runs() : runs().slice(0, MAX_VISIBLE_RUNS)
  const hasOverflow = (): boolean => runs().length > MAX_VISIBLE_RUNS

  const overflowHint = (): string => {
    const hidden = runs().length - MAX_VISIBLE_RUNS
    const running = runs().filter((r) => r.status === 'running').length
    const parts: string[] = []
    if (running > 0) parts.push(`${running} ${t('tui.chrome.workflowPanel.running')}`)
    const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''
    return `  … ${t('tui.chrome.workflowPanel.moreRuns', { count: hidden })}${suffix}`
  }

  return (
    <Show when={runs().length > 0}>
      <Clickable onClick={() => setExpanded((v) => !v)}>
        <Box flexDirection="column">
          <Box border={['top']} borderStyle="single" borderColor={currentTheme.color('border')} />
          <Text fg={currentTheme.color('primary')} attributes={currentTheme.attributes('bold')}>
            {`  ⚡ ${t('tui.chrome.workflowPanel.header')}`}
          </Text>
          <For each={visible()}>{(run) => <WorkflowRunRow run={run} />}</For>
          <Show when={!expanded() && hasOverflow()}>
            <Text fg={currentTheme.color('textDim')}>{overflowHint()}</Text>
          </Show>
        </Box>
      </Clickable>
    </Show>
  )
}

function WorkflowRunRow(props: { run: WorkflowRunData }) {
  const badge = (): string => statusBadge(props.run.status)
  const badgeFg = (): ColorInput => statusBadgeColor(props.run.status)
  const badgeBold = (): boolean => props.run.status === 'running'
  const elapsed = (): string => formatElapsed(props.run.startedAt, props.run.finishedAt)
  const phase = (): string | undefined => props.run.currentPhase
  const agents = (): string | null =>
    props.run.agentCount > 0
      ? t('tui.chrome.workflowPanel.agentCount', { count: props.run.agentCount })
      : null

  return (
    <Box flexDirection="row">
      <Text fg={currentTheme.color('text')}>{'  '}</Text>
      <Text
        fg={badgeFg()}
        attributes={badgeBold() ? currentTheme.attributes('bold') : undefined}
      >
        {badge()}
      </Text>
      <Text fg={currentTheme.color('text')}>{` ${props.run.name}`}</Text>
      <Text fg={currentTheme.color('textDim')}>{` · ${elapsed()}`}</Text>
      <Show when={phase() !== undefined && phase() !== ''}>
        <Text fg={currentTheme.color('textDim')}>{' · '}</Text>
        <Text fg={currentTheme.color('text')}>{phase()}</Text>
      </Show>
      <Show when={agents() !== null}>
        <Text fg={currentTheme.color('textDim')}>{` · ${agents()}`}</Text>
      </Show>
    </Box>
  )
}

function statusBadge(status: WorkflowStatus): string {
  switch (status) {
    case 'running':
      return '\u25CF';
    case 'completed':
      return '\u2713';
    case 'failed':
      return '\u2717';
    case 'cancelled':
      return '\u2298';
  }
}

function statusBadgeColor(status: WorkflowStatus): ColorInput {
  switch (status) {
    case 'running':
      return currentTheme.color('warning');
    case 'completed':
      return currentTheme.color('success');
    case 'failed':
      return currentTheme.color('error');
    case 'cancelled':
      return currentTheme.color('textDim');
  }
}

function formatElapsed(startedAt: number, finishedAt?: number): string {
  const ms = (finishedAt ?? Date.now()) - startedAt;
  if (ms < 1000) return '<1s';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}
