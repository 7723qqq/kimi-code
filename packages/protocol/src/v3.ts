/**
 * The v3 flat-entity transport (upstream kap-server `#3532`, design revision 1094).
 *
 * Where v1 ships one schema per occurrence, v3 ships *entities*: every message
 * upserts one entity, and a later message carrying the same identity is that
 * entity's next state — or, for the `.delta` variants, its next increment. The
 * identity is `agent_id : type : entity_id`, and `entity_id` is the first
 * non-empty id field the message carries, in `ENTITY_ID_FIELDS` order. Keeping the
 * probe order here means a client keys an entity exactly as the server does, which
 * is what lets a replayed turn land on its live twin.
 *
 * Field lists mirror `packages/kimi-agent/v3-message-contract.json` — the frozen
 * snapshot of upstream's union that `scripts/scan-parity.mjs` checks the Rust
 * types against — and the contract test parses an instance built from that
 * snapshot through these schemas, so a drift between the two is a test failure
 * rather than a rendering bug.
 *
 * Fields upstream types as a nested object or a JSON payload are carried as
 * `unknown`: the server passes them through, and a client that needs one of them
 * narrows it at the point of use.
 *
 *   WS      /api/v3/ws                 frames: ClientFrame / ServerMessage
 *   GET     /v1/sessions/{id}/history  query: HistoryQuery   data: HistoryResponse
 */

import { z } from 'zod';

/** Field names probed for an entity id, in the order the server probes them. */
export const ENTITY_ID_FIELDS = [
  'message_id',
  'tool_call_id',
  'interaction_id',
  'task_id',
  'todo_id',
  'system_id',
  'step_id',
  'turn_id',
  'agent_id',
] as const;

const payload = z.unknown();
const payloadArray = z.array(z.unknown());
const base = { session_id: z.string(), agent_id: z.string(), timestamp: z.number() };

const turn = z.object({
  ...base,
  type: z.literal('turn'),
  turn_id: z.string(),
  ordinal: z.number(),
  status: z.enum(['running', 'completed']),
  origin: z.object({ kind: z.string() }).loose(),
  user_message_id: z.string().optional(),
  attachment_ids: payloadArray.optional(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  usage: payload.optional(),
  duration_ms: z.number().optional(),
});

const step = z.object({
  ...base,
  type: z.literal('step'),
  step_id: z.string(),
  turn_id: z.string(),
  ordinal: z.number(),
  status: z.enum(['running', 'completed', 'interrupted', 'failed']),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  usage: payload.optional(),
  finish_reason: z.string().optional(),
  timing: payload.optional(),
  retry: payload.optional(),
  end_reason: z.string().optional(),
  end_message: z.string().optional(),
});

const user = z.object({
  session_id: z.string(),
  agent_id: z.string(),
  type: z.literal('user'),
  message_id: z.string(),
  turn_id: z.string().optional(),
  status: z.enum(['unread', 'read']),
  timestamp: z.number().optional(),
  text: payloadArray,
  attachment_ids: payloadArray.optional(),
  skill_activations: payloadArray.optional(),
  origin: payload.optional(),
});

const assistant = z.object({
  ...base,
  type: z.literal('assistant'),
  message_id: z.string(),
  turn_id: z.string(),
  step_id: z.string(),
  status: z.enum(['streaming', 'completed']),
  text: z.string(),
});

const assistantDelta = z.object({
  ...base,
  type: z.literal('assistant.delta'),
  message_id: z.string(),
  text: z.string(),
});

const thinking = z.object({
  ...base,
  type: z.literal('thinking'),
  message_id: z.string(),
  turn_id: z.string(),
  step_id: z.string(),
  status: z.enum(['streaming', 'completed']),
  text: z.string(),
});

const thinkingDelta = z.object({
  ...base,
  type: z.literal('thinking.delta'),
  message_id: z.string(),
  text: z.string(),
});

const toolCall = z.object({
  ...base,
  type: z.literal('tool_call'),
  tool_call_id: z.string(),
  turn_id: z.string(),
  step_id: z.string(),
  name: z.string(),
  view: z.string().optional(),
  status: z.enum(['running', 'done', 'error']),
  input: payload.optional(),
  input_text: z.string().optional(),
  output: payload.optional(),
  display: payload.optional(),
  error: z.string().optional(),
  progress: payload.optional(),
  task_id: z.string().optional(),
  approval_id: z.string().optional(),
  todo_id: z.string().optional(),
  agent_refs: payloadArray.optional(),
});

const toolCallDelta = z.object({
  ...base,
  type: z.literal('tool_call.delta'),
  tool_call_id: z.string(),
  input_text: z.string(),
});

const toolProgress = z.object({
  ...base,
  type: z.literal('tool.progress'),
  tool_call_id: z.string(),
  progress: z.object({ kind: z.string() }).loose(),
});

const system = z.object({
  ...base,
  type: z.literal('system'),
  system_id: z.string(),
  at: z.string().optional(),
  subtype: z.enum([
    'compaction',
    'undo',
    'clear',
    'goal',
    'plan.enter',
    'plan.exit',
    'plan.revision',
    'swarm.enter',
    'swarm.exit',
    'notice',
    'hook',
    'interruption',
  ]),
  payload: payload.optional(),
});

const interaction = z.object({
  ...base,
  type: z.literal('interaction'),
  interaction_id: z.string(),
  status: z.enum([
    'pending',
    'approved',
    'rejected',
    'cancelled',
    'answered',
    'dismissed',
  ]),
  tool_call_id: z.string().optional(),
  kind: z.enum(['approval', 'question']),
  request: payload.optional(),
  response: payload.optional(),
});

const task = z.object({
  ...base,
  type: z.literal('task'),
  task_id: z.string(),
  kind: z.enum(['shell', 'subagent', 'tool', 'other']),
  status: z.enum(['running', 'completed', 'failed', 'timed_out', 'killed', 'lost']),
  detached: z.boolean(),
  description: z.string().optional(),
  child_agent_id: z.string().optional(),
  output_tail: z.string(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  result_summary: z.string().optional(),
  error: z.string().optional(),
  state_reason: z.string().optional(),
  usage: payload.optional(),
  model: z.string().optional(),
  thinking_effort: z.string().optional(),
});

const todoItem = z.object({
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'done']),
});

const todo = z.object({
  ...base,
  type: z.literal('todo'),
  todo_id: z.string(),
  items: z.array(todoItem),
  updated_at: z.string().optional(),
});

const agentState = z.object({
  ...base,
  type: z.literal('agent.state'),
  profile: payload,
  origin: payload,
  created_at: z.string(),
  ended_at: z.string().optional(),
  status: z.enum(['idle', 'running', 'interrupted', 'completed', 'failed']),
  turn: payload.optional(),
});

const sessionState = z.object({
  session_id: z.string(),
  type: z.literal('session.state'),
  timestamp: z.number(),
  status: z.enum(['idle', 'running', 'compacting']),
  pending_interaction: z.enum(['none', 'approval', 'question']).optional(),
  model: z.string().optional(),
  thinking_effort: z.string().optional(),
  permission: z.enum(['manual', 'yolo', 'auto']).optional(),
  usage: payload.optional(),
  context_tokens: z.number().optional(),
  max_context_tokens: z.number().optional(),
  goal: payload.optional(),
  modes: payload.optional(),
});

const session = z.object({
  type: z.literal('session'),
  timestamp: z.number(),
  subtype: z.enum(['created', 'updated', 'archived', 'deleted']),
  session: payload,
  changed_fields: payloadArray.optional(),
});

const workspace = z.object({
  type: z.literal('workspace'),
  timestamp: z.number(),
  subtype: z.enum(['created', 'updated', 'deleted']),
  workspace: payload,
});

const config = z.object({
  type: z.literal('config'),
  timestamp: z.number(),
  config: payload,
  changed_fields: payloadArray.optional(),
});

const configWarning = z.object({
  type: z.literal('config.warning'),
  timestamp: z.number(),
  warnings: payloadArray,
});

const modelCatalog = z.object({ type: z.literal('model_catalog'), timestamp: z.number() });
const plugin = z.object({ type: z.literal('plugin'), timestamp: z.number() });
const capability = z.object({
  type: z.literal('capability'),
  timestamp: z.number(),
  capability_id: z.string().optional(),
});

const hello = z.object({
  type: z.literal('hello'),
  protocol_version: z.string(),
  server_id: z.string(),
  capabilities: z.array(z.string()),
});

const ack = z.object({
  type: z.literal('ack'),
  id: z.number(),
  code: z.number(),
  msg: z.string().optional(),
});

const error = z.object({ type: z.literal('error'), code: z.number(), msg: z.string() });

/** Every frame the server can put on a v3 socket. */
export const v3ServerMessageSchema = z.discriminatedUnion('type', [
  turn,
  step,
  user,
  assistant,
  assistantDelta,
  thinking,
  thinkingDelta,
  toolCall,
  toolCallDelta,
  toolProgress,
  system,
  interaction,
  task,
  todo,
  agentState,
  sessionState,
  session,
  workspace,
  config,
  configWarning,
  modelCatalog,
  plugin,
  capability,
  hello,
  ack,
  error,
]);

/** Every frame a client may send; anything else is a validation failure. */
export const v3ClientFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    id: z.number(),
    session_id: z.string(),
    agent_ids: z.array(z.string()).optional(),
    omit: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal('unsubscribe'), id: z.number(), session_id: z.string() }),
]);

/**
 * The identity one entity upserts under: the same three segments the server keys
 * it by, so an entity that arrives twice is recognised as one.
 */
export function v3EntityKey(message: V3ServerMessage): string {
  const fields = message as Record<string, unknown>;
  const entityId =
    ENTITY_ID_FIELDS.map((name) => fields[name]).find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ) ?? (typeof fields['agent_id'] === 'string' ? fields['agent_id'] : '');
  const agentId = typeof fields['agent_id'] === 'string' ? fields['agent_id'] : '';
  return `${agentId}:${message.type}:${entityId}`;
}

/**
 * Paging over whole turns: a page never splits one, so `before_turn` and
 * `after_step` are mutually exclusive cursors and `page_size` counts turns.
 */
export const v3HistoryQuerySchema = z.object({
  before_turn: z.string().optional(),
  after_step: z.string().optional(),
  page_size: z.coerce.number().int().min(1).max(500).optional(),
  agent_id: z.string().optional(),
});

export const v3HistoryResponseSchema = z.object({
  messages: z.array(v3ServerMessageSchema),
  has_more: z.boolean(),
  in_flight: z.object({ turn_id: z.string(), step_id: z.string() }).optional(),
});

export type V3ServerMessage = z.infer<typeof v3ServerMessageSchema>;
export type V3ClientFrame = z.infer<typeof v3ClientFrameSchema>;
export type V3HistoryQuery = z.infer<typeof v3HistoryQuerySchema>;
export type V3HistoryResponse = z.infer<typeof v3HistoryResponseSchema>;
