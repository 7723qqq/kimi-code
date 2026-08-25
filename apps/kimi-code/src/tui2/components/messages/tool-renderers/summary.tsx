/** @jsxImportSource @opentui/solid */
/**
 * TUI2 summary-style tool result renderers.
 *
 * Mirrors `tui/components/messages/tool-renderers/summary.ts`. Produces
 * optional inline-glance content for tools whose raw output is
 * high-volume but low-information (Grep, Glob). The numeric summary
 * (line counts, exit codes, sizes) lives in the header chip (see
 * chip.ts), so most tools intentionally render an empty body and only
 * expose details when the global expand toggle is on.
 *
 * Errors always fall through to the truncated renderer so the user sees
 * the actual error message, not a synthetic summary.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { JSX } from 'solid-js'

import { t } from '#/i18n'

import { currentTheme } from '../../../theme'

import { Box } from '../../common/box'
import { Text } from '../../common/text'
import { renderTruncated } from './truncated'
import type { ResultRenderer } from './types'

const GLANCE_SAMPLES = 3

type GlanceFn = (
  toolCall: Parameters<ResultRenderer>[0],
  result: Parameters<ResultRenderer>[1],
) => string

function withGlance(glance: GlanceFn | null): ResultRenderer {
  return (toolCall, result, ctx) => {
    if (result.is_error) return renderTruncated(toolCall, result, ctx)

    const rows: JSX.Element[] = []
    if (glance !== null) {
      const line = glance(toolCall, result)
      if (line.length > 0) {
        rows.push(
          <Text fg={currentTheme.color('textDim')} attributes={currentTheme.attributes('dim')} wrapMode="word">
            {line}
          </Text>,
        )
      }
    }
    if (ctx.expanded && result.output.length > 0) {
      // v1 indented the expanded body four cells; the glance row sits at the
      // parent's two-cell gutter, so the body gets a nested two-cell box.
      rows.push(
        <Box flexDirection="column" paddingLeft={2}>
          <Text fg={currentTheme.color('textDim')} wrapMode="word">
            {result.output}
          </Text>
        </Box>,
      )
    }
    return <>{rows}</>
  }
}

function nonEmptyLines(text: string): string[] {
  if (text.length === 0) return []
  return text.split('\n').filter((line) => line.length > 0)
}

// Strip a trailing `:line:col:text` so the glance shows the file path
// only, even when grep is in `content` mode (`src/foo.ts:42:    foo()`).
function pathFromGrepLine(line: string): string {
  const idx = line.indexOf(':')
  if (idx <= 0) return line
  const second = line.indexOf(':', idx + 1)
  if (second <= 0) return line
  return line.slice(0, second)
}

const grepGlance: GlanceFn = (_toolCall, result) => {
  const lines = nonEmptyLines(result.output)
  if (lines.length === 0) return ''
  const samples = lines.slice(0, GLANCE_SAMPLES).map(pathFromGrepLine)
  const remaining = lines.length - samples.length
  const tail = remaining > 0 ? `, +${String(remaining)} ${t('tui.statusMessages.more')}` : ''
  return `${samples.join(', ')}${tail}`
}

const globGlance: GlanceFn = (_toolCall, result) => {
  const lines = nonEmptyLines(result.output)
  if (lines.length === 0) return ''
  const samples = lines.slice(0, GLANCE_SAMPLES)
  const remaining = lines.length - samples.length
  const tail = remaining > 0 ? `, +${String(remaining)} ${t('tui.statusMessages.more')}` : ''
  return `${samples.join(', ')}${tail}`
}

// ── Exports ──────────────────────────────────────────────────────────

// Tools whose chip already conveys everything — the body is empty in
// the collapsed state and only the raw output appears when expanded.
export const readSummary: ResultRenderer = withGlance(null)
export const fetchSummary: ResultRenderer = withGlance(null)
export const webSearchSummary: ResultRenderer = withGlance(null)
export const thinkSummary: ResultRenderer = withGlance(null)
export const editSummary: ResultRenderer = withGlance(null)
export const writeSummary: ResultRenderer = withGlance(null)

// Tools that benefit from inline path samples below the chip.
export const grepSummary: ResultRenderer = withGlance(grepGlance)
export const globSummary: ResultRenderer = withGlance(globGlance)
