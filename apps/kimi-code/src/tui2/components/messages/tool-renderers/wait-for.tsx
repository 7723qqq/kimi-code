/** @jsxImportSource @opentui/solid */
/**
 * TUI2 WaitFor renderer.
 *
 * Mirrors `tui/components/messages/tool-renderers/wait-for.ts`. The wait
 * result is a timeline (header fields, then `[finished]` /
 * `[completed_during_wait]` / `[still_running]` sections), so the
 * collapsed body shows what the wait came back with instead of the raw
 * key-value dump: the finished task with its outcome, plus counts of
 * tasks that finished alongside or are still running. A timeout is not
 * an error (the tool says so itself), so it renders in the dim tone.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import { For, Show } from 'solid-js'

import { currentTheme } from '../../../theme'

import { Box } from '../../common/box'
import { Text } from '../../common/text'
import { renderTruncated } from './truncated'
import type { ResultRenderer } from './types'

const DESCRIPTION_MAX = 72
const RUNNING_SAMPLES = 3

type WaitForStatus = 'completed' | 'timed_out' | 'no_tasks'

interface WaitForResultView {
  readonly status: WaitForStatus
  readonly waitedMs: number
  readonly finishedTaskId?: string
  readonly finishedStatus?: string
  readonly finishedDescription?: string
  readonly extraCount: number
  readonly runningCount: number
  readonly runningSamples: readonly string[]
}

export const waitForSummary: ResultRenderer = (toolCall, result, ctx) => {
  if (result.is_error) return renderTruncated(toolCall, result, ctx)
  const view = parseWaitForOutput(result.output)
  if (view === undefined) return renderTruncated(toolCall, result, ctx)

  const fg = currentTheme.color('textDim')
  const lines = glanceLines(view)
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <For each={lines}>
        {(line) => (
          <Text fg={fg} attributes={currentTheme.attributes('dim')} wrapMode="word">
            {line}
          </Text>
        )}
      </For>
      <Show when={ctx.expanded && result.output.length > 0}>
        {/* v1 indented the expanded body four cells; the glance rows sit at
            this box's two-cell gutter, so the body gets a nested two-cell
            box. */}
        <Box flexDirection="column" paddingLeft={2}>
          <Text fg={fg} wrapMode="word">
            {result.output}
          </Text>
        </Box>
      </Show>
    </Box>
  )
}

export function parseWaitForOutput(output: string): WaitForResultView | undefined {
  const status = field(output, 'wait_status')
  if (status !== 'completed' && status !== 'timed_out' && status !== 'no_tasks') return undefined
  const waitedMs = Number(field(output, 'waited_ms') ?? 0)
  const finished = section(output, 'finished')
  const duringWait = section(output, 'completed_during_wait')
  const stillRunning = section(output, 'still_running')
  const runningCount =
    stillRunning === undefined ? 0 : countField(stillRunning, 'active_background_tasks')
  return {
    status,
    waitedMs: Number.isFinite(waitedMs) ? waitedMs : 0,
    finishedTaskId: field(output, 'task_id'),
    finishedStatus: finished === undefined ? undefined : field(finished, 'status'),
    finishedDescription: finished === undefined ? undefined : field(finished, 'description'),
    extraCount: duringWait === undefined ? 0 : countOccurrences(duringWait, /^task_id: /gm),
    runningCount,
    runningSamples:
      stillRunning === undefined ? [] : sampleDescriptions(stillRunning, runningCount),
  }
}

function glanceLines(view: WaitForResultView): string[] {
  switch (view.status) {
    case 'no_tasks':
      return []
    case 'timed_out': {
      if (view.runningCount === 0) return []
      const summary = `${pluralizeTasks(view.runningCount)} still running`
      if (view.runningSamples.length === 0) return [summary]
      const remaining = view.runningCount - view.runningSamples.length
      const tail = remaining > 0 ? `, +${String(remaining)} more` : ''
      return [`${summary}: ${view.runningSamples.join(', ')}${tail}`]
    }
    case 'completed': {
      const taskId = view.finishedTaskId ?? 'task'
      const status = view.finishedStatus ?? 'completed'
      const marker = status === 'completed' ? '✓' : '✗'
      const description =
        view.finishedDescription === undefined
          ? ''
          : ` · ${truncateOneLine(view.finishedDescription, DESCRIPTION_MAX)}`
      const lines = [`${marker} ${taskId} ${status}${description}`]
      const parts: string[] = []
      if (view.extraCount > 0) parts.push(`+${String(view.extraCount)} more finished during wait`)
      if (view.runningCount > 0) parts.push(`${pluralizeTasks(view.runningCount)} still running`)
      if (parts.length > 0) lines.push(parts.join(' · '))
      return lines
    }
  }
}

function pluralizeTasks(count: number): string {
  return `${String(count)} background task${count === 1 ? '' : 's'}`
}

function field(text: string, name: string): string | undefined {
  const match = new RegExp(`^${name}: (.+)$`, 'm').exec(text)
  return match?.[1]
}

function countField(text: string, name: string): number {
  const value = Number(field(text, name) ?? 0)
  return Number.isFinite(value) ? value : 0
}

function section(output: string, name: string): string | undefined {
  const match = new RegExp(`^\\[${name}\\]$`, 'm').exec(output)
  if (match === null) return undefined
  const rest = output.slice(match.index + match[0].length)
  const next = /^\[/m.exec(rest)
  return (next === null ? rest : rest.slice(0, next.index)).trim()
}

function countOccurrences(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

function sampleDescriptions(stillRunning: string, runningCount: number): readonly string[] {
  const descriptions = [...stillRunning.matchAll(/^description: (.+)$/gm)].map((match) =>
    truncateOneLine(match[1] ?? '', 40),
  )
  return descriptions.slice(0, Math.min(RUNNING_SAMPLES, runningCount))
}

function truncateOneLine(text: string, max: number): string {
  const firstLine = text.replaceAll(/\s+/g, ' ').trim()
  if (firstLine.length <= max) return firstLine
  return `${firstLine.slice(0, Math.max(0, max - 1))}…`
}
