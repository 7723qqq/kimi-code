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
 * Payloads the fork already owns a schema for are wired in rather than
 * re-declared: `tool_call.display` and an approval request's
 * `tool_input_display` are `ToolInputDisplay`s (`display.ts`), an approval
 * response is `approvalResponseSchema` (`approval.ts`), and a question
 * response's answers are `questionAnswerSchema` (`question.ts`). Everything
 * else upstream leaves opaque stays `unknown`, narrowed at the point of use.
 *
 *   WS      /api/v3/ws                 frames: ClientFrame / ServerMessage
 *   GET     /v1/sessions/{id}/history  query: HistoryQuery   data: HistoryResponse
 */

import { z } from 'zod';

import { approvalResponseSchema, type ApprovalResponse } from './approval';
import { ToolInputDisplaySchema } from './display';
import { questionAnswerSchema, questionAnswerMethodSchema } from './question';
import { isoDateTimeSchema } from './time';

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

const turnUsage = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cached_tokens: z.number().optional(),
  cost: z.number().optional(),
});

const stepUsage = z.object({
  input_other: z.number(),
  output: z.number(),
  input_cache_read: z.number(),
  input_cache_creation: z.number(),
});

const stepTiming = z.object({
  llm_first_token_ms: z.number().optional(),
  llm_stream_duration_ms: z.number().optional(),
});

const stepRetry = z.object({
  failed_attempt: z.number(),
  next_attempt: z.number(),
  max_attempts: z.number(),
  delay_ms: z.number(),
  error_name: z.string(),
  error_message: z.string(),
  status_code: z.number().optional(),
});

const turn = z.object({
  ...base,
  type: z.literal('turn'),
  turn_id: z.string(),
  ordinal: z.number(),
  status: z.enum(['running', 'completed']),
  origin: z.object({ kind: z.string() }).loose(),
  user_message_id: z.string().optional(),
  attachment_ids: z.array(z.string()).optional(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  usage: turnUsage.optional(),
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
  usage: stepUsage.optional(),
  finish_reason: z.string().optional(),
  timing: stepTiming.optional(),
  retry: stepRetry.optional(),
  end_reason: z.string().optional(),
  end_message: z.string().optional(),
});

const contentPart = z.object({
  type: z.enum(['text', 'think', 'image', 'audio', 'video']),
  text: z.string(),
  meta: z.record(z.string(), z.unknown()),
});

const skillActivation = z.object({
  skill_name: z.string(),
  skill_args: z.string().optional(),
});

const userMessageOrigin = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    cron_id: z.string().optional(),
    schedule: z.string().optional(),
  }),
  z.object({
    kind: z.literal('cron'),
    cron_id: z.string().optional(),
    schedule: z.string().optional(),
  }),
  z.object({
    kind: z.literal('task'),
    task_id: z.string(),
    title: z.string(),
    body: z.string(),
    severity: z.string().optional(),
    type: z.string().optional(),
    source_kind: z.string().optional(),
    source_id: z.string().optional(),
    agent_id: z.string().optional(),
    raw: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal('skill'),
    skill_name: z.string(),
    args: z.string().optional(),
    trigger: z.string().optional(),
  }),
]);

const user = z.object({
  session_id: z.string(),
  agent_id: z.string(),
  type: z.literal('user'),
  message_id: z.string(),
  turn_id: z.string().optional(),
  status: z.enum(['unread', 'read']),
  timestamp: z.number().optional(),
  text: z.array(contentPart),
  attachment_ids: z.array(z.string()).optional(),
  skill_activations: z.array(skillActivation).optional(),
  origin: userMessageOrigin.optional(),
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

const toolProgressPayload = z.object({
  kind: z.enum(['stdout', 'stderr', 'progress', 'status', 'custom']),
  text: z.string().optional(),
  percent: z.number().optional(),
  custom_kind: z.string().optional(),
  custom_data: z.unknown().optional(),
});

const toolCallAgentRef = z.object({
  agent_id: z.string(),
  role: z.enum(['child', 'member']).optional(),
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
  display: ToolInputDisplaySchema.optional(),
  error: z.string().optional(),
  progress: toolProgressPayload.optional(),
  task_id: z.string().optional(),
  approval_id: z.string().optional(),
  todo_id: z.string().optional(),
  agent_refs: z.array(toolCallAgentRef).optional(),
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
  progress: toolProgressPayload,
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

const interactionStatus = z.enum([
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'answered',
  'dismissed',
]);

const interactionApprovalRequest = z.object({
  tool_name: z.string(),
  action: z.string(),
  tool_input_display: ToolInputDisplaySchema.optional(),
  expires_at: isoDateTimeSchema.optional(),
});

const interactionQuestionOption = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

const interactionQuestionItem = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  body: z.string().optional(),
  options: z.array(interactionQuestionOption),
  multi_select: z.boolean().optional(),
  allow_other: z.boolean().optional(),
  other_label: z.string().optional(),
  other_description: z.string().optional(),
});

const interactionQuestionRequest = z.object({
  questions: z.array(interactionQuestionItem),
});

const interactionQuestionResponse = z.object({
  answers: z.record(z.string(), questionAnswerSchema),
  method: questionAnswerMethodSchema.optional(),
  note: z.string().optional(),
});

const interactionBase = {
  ...base,
  type: z.literal('interaction'),
  interaction_id: z.string(),
  status: interactionStatus,
  tool_call_id: z.string().optional(),
};

const interaction = z.discriminatedUnion('kind', [
  z.object({
    ...interactionBase,
    kind: z.literal('approval'),
    request: interactionApprovalRequest.optional(),
    response: approvalResponseSchema.optional(),
  }),
  z.object({
    ...interactionBase,
    kind: z.literal('question'),
    request: interactionQuestionRequest.optional(),
    response: interactionQuestionResponse.optional(),
  }),
]);

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

const sessionStateGoal = z.object({
  objective: z.string(),
  status: z.enum(['active', 'paused', 'blocked', 'complete']),
  completion_criterion: z.string().optional(),
  budget_used: z.number().optional(),
  budget_limit: z.number().optional(),
});

const sessionStateModes = z.object({
  plan: z
    .object({
      review_path: z.string().optional(),
      version: z.number().optional(),
    })
    .optional(),
  swarm: z
    .object({
      trigger: z.string().optional(),
    })
    .optional(),
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
  goal: sessionStateGoal.optional(),
  modes: sessionStateModes.optional(),
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

/**
 * The subset a history page can carry: persisted entities only, never the
 * delta family (a page holds whole entities) and never a global frame.
 */
export const v3HistoryMessageSchema = z.discriminatedUnion('type', [
  turn,
  step,
  user,
  assistant,
  thinking,
  toolCall,
  system,
  interaction,
  task,
  todo,
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
  messages: z.array(v3HistoryMessageSchema),
  has_more: z.boolean(),
  in_flight: z.object({ turn_id: z.string(), step_id: z.string() }).optional(),
});

export type TurnMessage = z.infer<typeof turn>;
export type StepMessage = z.infer<typeof step>;
export type UserMessage = z.infer<typeof user>;
export type AssistantMessage = z.infer<typeof assistant>;
export type AssistantDelta = z.infer<typeof assistantDelta>;
export type ThinkingMessage = z.infer<typeof thinking>;
export type ThinkingDelta = z.infer<typeof thinkingDelta>;
export type ToolCallMessage = z.infer<typeof toolCall>;
export type ToolCallDelta = z.infer<typeof toolCallDelta>;
export type ToolProgress = z.infer<typeof toolProgress>;
export type SystemMessage = z.infer<typeof system>;
export type InteractionMessage = z.infer<typeof interaction>;
export type TaskMessage = z.infer<typeof task>;
export type TodoMessage = z.infer<typeof todo>;
export type AgentStateMessage = z.infer<typeof agentState>;
export type SessionStateMessage = z.infer<typeof sessionState>;
export type SessionMessage = z.infer<typeof session>;
export type WorkspaceMessage = z.infer<typeof workspace>;
export type ConfigMessage = z.infer<typeof config>;
export type ConfigWarningMessage = z.infer<typeof configWarning>;
export type ModelCatalogMessage = z.infer<typeof modelCatalog>;
export type PluginMessage = z.infer<typeof plugin>;
export type CapabilityMessage = z.infer<typeof capability>;
export type HelloMessage = z.infer<typeof hello>;
export type AckMessage = z.infer<typeof ack>;
export type ErrorMessage = z.infer<typeof error>;

export type ContentPart = z.infer<typeof contentPart>;
export type SkillActivation = z.infer<typeof skillActivation>;
export type TurnUsage = z.infer<typeof turnUsage>;
export type StepUsage = z.infer<typeof stepUsage>;
export type StepTiming = z.infer<typeof stepTiming>;
export type StepRetry = z.infer<typeof stepRetry>;
export type UserMessageOrigin = z.infer<typeof userMessageOrigin>;
export type SessionStateGoal = z.infer<typeof sessionStateGoal>;
export type SessionStateModes = z.infer<typeof sessionStateModes>;
export type ToolProgressPayload = z.infer<typeof toolProgressPayload>;
export type ToolCallAgentRef = z.infer<typeof toolCallAgentRef>;
export type InteractionStatus = z.infer<typeof interactionStatus>;
export type InteractionApprovalRequest = z.infer<typeof interactionApprovalRequest>;
export type InteractionApprovalResponse = ApprovalResponse;
export type InteractionQuestionOption = z.infer<typeof interactionQuestionOption>;
export type InteractionQuestionItem = z.infer<typeof interactionQuestionItem>;
export type InteractionQuestionRequest = z.infer<typeof interactionQuestionRequest>;
export type InteractionQuestionResponse = z.infer<typeof interactionQuestionResponse>;

export type V3ServerMessage = z.infer<typeof v3ServerMessageSchema>;
export type V3HistoryMessage = z.infer<typeof v3HistoryMessageSchema>;
export type V3ClientFrame = z.infer<typeof v3ClientFrameSchema>;
export type V3HistoryQuery = z.infer<typeof v3HistoryQuerySchema>;
export type V3HistoryResponse = z.infer<typeof v3HistoryResponseSchema>;
