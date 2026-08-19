/**
 * TUI2 workflow panel controller — tracks active workflow runs from session
 * events and feeds them into the response store.
 *
 * Replaces `tui/controllers/workflow-panel.ts`'s `WorkflowPanelController`.
 * The v1 controller pushed runs into a `WorkflowPanelComponent` instance and
 * called `requestRender()`; the tui2 version writes `store.state.workflowRuns`
 * and the opentui reconciler re-renders the panel automatically.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Event } from '@moonshot-ai/kimi-code-sdk';

import type { Tui2EventBus } from '../event';
import type { Tui2Store } from '../state';
import type { WorkflowRunData, WorkflowStatus } from '../types';

export interface WorkflowPanelController {
  /** Clear all tracked runs. */
  clear(): void;
  /** Unsubscribe from the event bus. */
  dispose(): void;
}

/**
 * Create a workflow-panel controller over an event bus + response store.
 * Listens for Workflow tool calls/results and builds a live list of runs.
 */
export function createWorkflowPanelController(
  bus: Tui2EventBus,
  store: Tui2Store,
): WorkflowPanelController {
  const runs = new Map<string, WorkflowRunData>();
  /** Track which toolCallId maps to which runId so we can match result events. */
  const pendingRuns = new Map<string, { name: string; runId: string }>();

  const publish = (): void => {
    store.setState('workflowRuns', [...runs.values()]);
  };

  const handleToolCall = (event: Extract<Event, { type: 'tool.call.started' }>): void => {
    // Only care about the Workflow tool.
    if (event.name !== 'Workflow') return;

    // Try to extract the operation and run_id from the args.
    // The args are a JSON string at this point.
    let args: Record<string, unknown> = {};
    try {
      if (typeof event.args === 'string') {
        args = JSON.parse(event.args) as Record<string, unknown>;
      } else {
        args = event.args as Record<string, unknown>;
      }
    } catch {
      return;
    }

    const operation = args['operation'] as string | undefined;
    if (operation === 'run') {
      // A new workflow run started — we don't have the runId yet, so
      // we'll capture it when the result comes back.
      const name = (args['name'] as string) ?? 'inline';
      pendingRuns.set(event.toolCallId, { name, runId: '' });
    }
    // Status/wait operations may return updated status; handled in the result handler.
  };

  const handleToolResult = (event: Extract<Event, { type: 'tool.result' }>): void => {
    // Check if this is a Workflow tool result.
    // We look for run_id: and status: patterns in the output.
    const output = event.output;
    if (typeof output !== 'string') return;

    // Try to extract run_id from the output.
    const runIdMatch = output.match(/run_id:\s*(\S+)/);
    if (!runIdMatch) return;
    const runId = runIdMatch[1]!;

    // Extract status.
    const statusMatch = output.match(/status:\s*(\S+)/);
    const status = parseStatus(statusMatch?.[1]);

    // Extract phase.
    const phaseMatch = output.match(/phase:\s*(.+)/);
    const phase = phaseMatch?.[1];

    // Extract agent count.
    const agentsMatch = output.match(/agents:\s*(\d+)/);
    const agentCount = agentsMatch ? parseInt(agentsMatch[1]!, 10) : 0;

    // Extract elapsed time to back-calculate finishedAt.
    const elapsedMatch = output.match(/elapsed:\s*([\d.]+)s/);
    const elapsedSec = elapsedMatch ? parseFloat(elapsedMatch[1]!) : 0;

    // Check if this result is from a "run" operation (we have a pending entry).
    const pending = pendingRuns.get(event.toolCallId);
    const name = pending?.name ?? 'workflow';

    // Clean up pending entry.
    if (pending) {
      pendingRuns.delete(event.toolCallId);
    }

    // Build the run data.
    const now = Date.now();
    const existing = runs.get(runId);

    const runData: WorkflowRunData = {
      runId,
      name: existing?.name ?? name,
      status,
      currentPhase: phase ?? existing?.currentPhase,
      agentCount: Math.max(agentCount, existing?.agentCount ?? 0),
      startedAt: existing?.startedAt ?? now - elapsedSec * 1000,
      finishedAt: status !== 'running' ? (existing?.finishedAt ?? now) : undefined,
    };

    runs.set(runId, runData);
    publish();
  };

  const off = [
    bus.on('tool.call.started', handleToolCall),
    bus.on('tool.result', handleToolResult),
  ];

  return {
    clear(): void {
      runs.clear();
      pendingRuns.clear();
      store.setState('workflowRuns', []);
    },
    dispose(): void {
      for (const fn of off) fn();
    },
  };
}

function parseStatus(s?: string): WorkflowStatus {
  switch (s) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
}
