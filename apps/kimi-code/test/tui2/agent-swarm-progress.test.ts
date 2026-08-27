/**
 * Tests for the tui2 AgentSwarm result-summary parsing layer and the
 * pure tone/label helpers shared by the tui2 view.
 *
 * The tui2 tree consumes swarm progress through
 * `agentSwarmResultSummaryFromOutput`. The view's status→tone and
 * status→label mappings live in `agent-swarm-progress-view.tsx` as
 * pure helpers; mounted-component tests are blocked by opentui's
 * renderer context (see `tool-renderers.test.ts`), so tone/label are
 * pinned here instead.
 *
 * Parsing contract pinned below: XML `<subagent outcome=...>` blocks
 * win over the legacy `[agent N]` / `status:` format, and the counters
 * split completed / failed / aborted.
 */

import { describe, expect, it } from 'vitest'

import { agentSwarmResultSummaryFromOutput } from '@/tui2/components/messages/agent-swarm-progress'
import {
  swarmStatusLabel,
  swarmStatusTone,
} from '@/tui2/components/messages/agent-swarm-progress-view'

describe('agentSwarmResultSummaryFromOutput', () => {
  it('parses XML subagent outcomes into counters', () => {
    const output = [
      '<agent_swarm_result>',
      '<summary>completed: 1, failed: 1, aborted: 1</summary>',
      '<subagent index="1" agent_id="agent-1" outcome="completed">All green.</subagent>',
      '<subagent index="2" agent_id="agent-2" outcome="failed">Timed out.</subagent>',
      '<subagent index="3" agent_id="agent-3" outcome="aborted">Interrupted.</subagent>',
      '</agent_swarm_result>',
    ].join('\n')

    expect(agentSwarmResultSummaryFromOutput(output)).toEqual({
      completed: 1,
      failed: 1,
      aborted: 1,
      parsed: true,
    })
  })

  it('treats aborted and cancelled outcomes as aborted', () => {
    const output = [
      '<subagent index="1" outcome="cancelled">User interrupted.</subagent>',
      '<subagent index="2" outcome="aborted">Interrupted.</subagent>',
    ].join('\n')

    expect(agentSwarmResultSummaryFromOutput(output)).toEqual({
      completed: 0,
      failed: 0,
      aborted: 2,
      parsed: true,
    })
  })

  it('applies no-index XML outcomes by tag order', () => {
    const output = [
      '<subagent agent_id="agent-1" outcome="failed">Agent timed out after 30s.</subagent>',
      '<subagent agent_id="agent-2" outcome="completed">Done.</subagent>',
    ].join('\n')

    expect(agentSwarmResultSummaryFromOutput(output)).toEqual({
      completed: 1,
      failed: 1,
      aborted: 0,
      parsed: true,
    })
  })

  it('prefers XML outcomes over legacy blocks when both are present', () => {
    const output = [
      '<agent_swarm_result>',
      '<subagent index="1" outcome="completed">All green.</subagent>',
      '</agent_swarm_result>',
      '[agent 1]',
      'status: failed',
      '',
      'subagent error: stale legacy failure.',
    ].join('\n')

    expect(agentSwarmResultSummaryFromOutput(output)).toEqual({
      completed: 1,
      failed: 0,
      aborted: 0,
      parsed: true,
    })
  })

  it('parses legacy [agent N] blocks with status lines', () => {
    const output = [
      '[agent 1]',
      'status: completed',
      '',
      '[summary]',
      'Reviewed imports and found no regressions.',
      '[agent 2]',
      'status: failed',
      '',
      'subagent error: provider request failed',
    ].join('\n')

    expect(agentSwarmResultSummaryFromOutput(output)).toEqual({
      completed: 1,
      failed: 1,
      aborted: 0,
      parsed: true,
    })
  })

  it('parses legacy cancelled status as aborted', () => {
    const output = ['[agent 1]', 'status: cancelled', '', 'subagent error: user abort'].join('\n')

    expect(agentSwarmResultSummaryFromOutput(output)).toEqual({
      completed: 0,
      failed: 0,
      aborted: 1,
      parsed: true,
    })
  })

  it('reports unparsed for output without any result markers', () => {
    expect(agentSwarmResultSummaryFromOutput('still running...')).toEqual({
      completed: 0,
      failed: 0,
      aborted: 0,
      parsed: false,
    })
  })

  it('ignores malformed subagent tags without a closing tag', () => {
    const output = '<subagent index="1" outcome="completed">unclosed'

    expect(agentSwarmResultSummaryFromOutput(output)).toEqual({
      completed: 0,
      failed: 0,
      aborted: 0,
      parsed: false,
    })
  })
})

describe('swarmStatusTone', () => {
  it('maps cancelled to warning', () => {
    expect(swarmStatusTone('cancelled')).toBe('warning')
  })
  it('maps ended to success', () => {
    expect(swarmStatusTone('ended')).toBe('success')
  })
  it('maps streaming and running to primary', () => {
    expect(swarmStatusTone('streaming')).toBe('primary')
    expect(swarmStatusTone('running')).toBe('primary')
  })
})

describe('swarmStatusLabel', () => {
  it('uses the cancelled label for cancelled status', () => {
    expect(swarmStatusLabel('cancelled')).toMatch(/cancel/i)
  })
  it('uses the completed label for ended status', () => {
    expect(swarmStatusLabel('ended')).toMatch(/completed/i)
  })
  it('uses the working label for running status', () => {
    expect(swarmStatusLabel('running')).toMatch(/working|run/i)
  })
  it('falls back to orchestrating for streaming status', () => {
    expect(swarmStatusLabel('streaming')).toMatch(/orchestrating/i)
  })
})