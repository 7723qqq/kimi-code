// Raw-frame event ledger for the trajectory view. The transcript projector
// folds frames into messages destructively; the ledger keeps the original
// sequence (main agent only) so the trajectory view can rebuild records,
// search, and measure timing independently. Ported from deepseek-harness
// ui-trajectory's "shared session window" data source (MIT).

export interface LedgerFrame {
  readonly seq: number;
  readonly type: string;
  readonly timestamp: string;
  readonly payload: Record<string, unknown> | null;
}

/** Frame types the ledger keeps (everything else is noise for the view). */
const LEDGER_FRAME_TYPES = new Set<string>([
  'prompt.submitted',
  'turn.started',
  'turn.step.started',
  'turn.step.completed',
  'turn.step.interrupted',
  'turn.step.retrying',
  'turn.ended',
  'assistant.delta',
  'thinking.delta',
  'tool.call.started',
  'tool.call.delta',
  'tool.use',
  'tool.result',
  'agent.status.updated',
  'session.history_compacted',
]);

/** Hard cap on retained frames per session (bounded memory for long sessions). */
export const LEDGER_MAX_FRAMES = 20_000;

export interface EventLedgerState {
  readonly frames: readonly LedgerFrame[];
}

export function createEventLedger(): EventLedgerState {
  return { frames: [] };
}

function isMainAgent(payload: Record<string, unknown> | null): boolean {
  const agentId = payload?.['agentId'];
  return typeof agentId !== 'string' || agentId === 'main';
}

/**
 * Append one frame; returns the same reference when the frame is not ledger
 * material. Keeps the newest LEDGER_MAX_FRAMES (drops the oldest prefix).
 */
export function feedLedger(state: EventLedgerState, frame: LedgerFrame): EventLedgerState {
  if (!LEDGER_FRAME_TYPES.has(frame.type)) return state;
  if (!isMainAgent(frame.payload)) return state;
  const frames =
    state.frames.length >= LEDGER_MAX_FRAMES
      ? [...state.frames.slice(state.frames.length - LEDGER_MAX_FRAMES + 1), frame]
      : [...state.frames, frame];
  return { frames };
}

export function clearLedger(): EventLedgerState {
  return createEventLedger();
}
