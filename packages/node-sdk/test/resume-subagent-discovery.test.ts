/**
 * Resume-side subagent discovery.
 *
 * A finished `AgentSwarm` call must come back with all of its members, not
 * none. The two result shapes the engine writes do not overlap — the single
 * agent's `agent_id:` / `[summary]` envelope versus the swarm's
 * `<agent_swarm_result>` XML — and a parser that only understood the first one
 * silently returned an empty roster, which is what made a resumed swarm
 * redraw as a pile of ordinary subagent cards.
 */
import { describe, expect, it } from 'vitest';

import { discoverSubagentsFromToolResult } from '../src/native/sdk-rpc-client-native';

/** v2 `formatForegroundAgentSuccess` / `swarm_tool.rs::render_swarm_results`. */
const AGENT_RESULT = [
  'agent_id: subagent-solo',
  'actual_subagent_type: coder',
  'status: completed',
  '',
  '[summary]',
  'solo result',
].join('\n');

const SWARM_RESULT = [
  '<agent_swarm_result>',
  '<summary>completed: 3</summary>',
  '<subagent agent_id="subagent-1" item="alpha" outcome="completed">did alpha</subagent>',
  '<subagent agent_id="subagent-2" item="beta" outcome="completed">did beta</subagent>',
  '<subagent agent_id="subagent-3" item="gamma" outcome="failed">blew up</subagent>',
  '</agent_swarm_result>',
].join('\n');

describe('discoverSubagentsFromToolResult', () => {
  it('recovers the single subagent of an Agent call', () => {
    expect(discoverSubagentsFromToolResult(AGENT_RESULT)).toEqual([
      { agentId: 'subagent-solo', summary: 'solo result' },
    ]);
  });

  it('recovers every member of a swarm, not just the first', () => {
    const found = discoverSubagentsFromToolResult(SWARM_RESULT);
    expect(found.map((m) => m.agentId)).toEqual(['subagent-1', 'subagent-2', 'subagent-3']);
    expect(found[0]?.summary).toBe('did alpha');
  });

  it('keeps a failed member — it was shown live and must stay on the card', () => {
    const found = discoverSubagentsFromToolResult(SWARM_RESULT);
    expect(found[2]).toEqual({ agentId: 'subagent-3', summary: 'blew up' });
  });

  it('does not confuse the two shapes', () => {
    // The swarm's `agent_id="…"` must never be read by the single-agent
    // `agent_id:` pattern, and vice versa.
    expect(discoverSubagentsFromToolResult(SWARM_RESULT)).toHaveLength(3);
    expect(discoverSubagentsFromToolResult(AGENT_RESULT)).toHaveLength(1);
  });

  it('returns nothing for an unrelated or empty result', () => {
    expect(discoverSubagentsFromToolResult('')).toEqual([]);
    expect(discoverSubagentsFromToolResult('Command output\nok\n')).toEqual([]);
  });

  it('handles a resumed member (no body) and an id-bearing error', () => {
    const mixed = [
      '<agent_swarm_result>',
      '<summary>completed: 1, failed: 1</summary>',
      '<subagent mode="resume" agent_id="subagent-r" outcome="completed">continued</subagent>',
      '<subagent agent_id="subagent-e" outcome="failed">boom</subagent>',
      '</agent_swarm_result>',
    ].join('\n');
    expect(discoverSubagentsFromToolResult(mixed).map((m) => m.agentId)).toEqual([
      'subagent-r',
      'subagent-e',
    ]);
  });
});
