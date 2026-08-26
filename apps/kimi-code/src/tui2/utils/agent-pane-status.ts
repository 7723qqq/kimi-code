/**
 * TUI2 agent-pane status derivation — pure helpers mapping streaming phases
 * and tool-call payloads to the agent pane's display vocabulary.
 *
 * Extracted from `controllers/kimi-tui.ts` (the 3700-line host class) so the
 * pane data mapping stays unit-testable without a TUI.
 *
 * Status: REAL (tui2). New file — no v1 counterpart.
 */

import { t } from '#/i18n';

import type { AgentPaneItem, AppState, ToolCallBlockData } from '../types';

/** Human label for the main agent's streaming phase (undefined when idle). */
export function mainAgentPhaseLabel(phase: AppState['streamingPhase']): string | undefined {
  switch (phase) {
    case 'thinking':
      return t('tui.chrome.agentPane.phaseThinking');
    case 'composing':
      return t('tui.chrome.agentPane.phaseComposing');
    case 'shell':
      return t('tui.chrome.agentPane.phaseShell');
    case 'waiting':
      return t('tui.chrome.agentPane.phaseWaiting');
    case 'idle':
      return undefined;
  }
}

/** Status badge for a subagent card: done / error / waiting / active. */
export function subagentStatus(data: ToolCallBlockData): AgentPaneItem['status'] {
  if (data.backgroundStatus !== undefined) {
    if (data.backgroundStatus.status === 'completed') return 'done';
    return 'error';
  }
  if (data.backgrounded === true) return 'waiting';
  if (data.result !== undefined) {
    return data.result.is_error === true ? 'error' : 'done';
  }
  return 'active';
}
