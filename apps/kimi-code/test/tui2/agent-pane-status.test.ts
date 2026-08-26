/**
 * TUI2 agent-pane status derivation tests.
 *
 * `mainAgentPhaseLabel` maps streaming phases to the pane's phase labels;
 * `subagentStatus` derives the card badge from the tool-call payload.
 */

import { describe, expect, it } from 'vitest'

import { mainAgentPhaseLabel, subagentStatus } from '@/tui2/utils/agent-pane-status'
import type { ToolCallBlockData } from '@/tui2/types'

describe('mainAgentPhaseLabel', () => {
  it('labels every non-idle phase and stays undefined when idle', () => {
    expect(mainAgentPhaseLabel('thinking')).toBeTruthy()
    expect(mainAgentPhaseLabel('composing')).toBeTruthy()
    expect(mainAgentPhaseLabel('shell')).toBeTruthy()
    expect(mainAgentPhaseLabel('waiting')).toBeTruthy()
    expect(mainAgentPhaseLabel('idle')).toBeUndefined()
  })
})

describe('subagentStatus', () => {
  const base = (): ToolCallBlockData => ({ id: 'tc1', name: 'Agent', args: {} })

  it('reports active while running without a result', () => {
    expect(subagentStatus(base())).toBe('active')
  })

  it('reports done/error from the result', () => {
    expect(subagentStatus({ ...base(), result: { tool_call_id: 'tc1', output: 'ok' } })).toBe('done')
    expect(
      subagentStatus({ ...base(), result: { tool_call_id: 'tc1', output: 'x', is_error: true } }),
    ).toBe('error')
  })

  it('reports waiting for backgrounded cards', () => {
    expect(subagentStatus({ ...base(), backgrounded: true })).toBe('waiting')
  })

  it('prefers the background status over the result', () => {
    expect(
      subagentStatus({
        ...base(),
        backgroundStatus: { status: 'completed' },
        result: { tool_call_id: 'tc1', output: 'x', is_error: true },
      }),
    ).toBe('done')
    expect(
      subagentStatus({
        ...base(),
        backgroundStatus: { status: 'failed' },
      }),
    ).toBe('error')
  })
})
