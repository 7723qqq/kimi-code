import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';
import { transcriptGradeSpecSchema, transcriptSeqSchema } from '@moonshot-ai/transcript';
import { z } from 'zod';

import { pushEventSchema } from './events-zod';
import { interactionEventMessageSchema } from './interaction';
import {
  agentEventMessageSchema,
  goalEventMessageSchema,
  todoEventMessageSchema,
  usageEventMessageSchema,
} from './ws-agent';
import {
  taskBackgroundMessageSchema,
  taskEventMessageSchema,
  taskListMessageSchema,
  taskOutputMessageSchema,
  taskStateSchema,
  taskStopMessageSchema,
  taskUnwatchMessageSchema,
  taskWatchMessageSchema,
} from './ws-task';

export const wsEventEnvelopeSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    type: z.string(),
    session_id: z.string().optional(),
    timestamp: isoDateTimeSchema,
    payload,
  });

export const subscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  request_id: z.string().min(1),
  session_id: z.string().min(1),
  agent_ids: z.array(z.string().min(1)).min(1).optional(),
  transcript: transcriptGradeSpecSchema.optional(),
  transcript_since: z.record(z.string(), transcriptSeqSchema).optional(),
});

export const unsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  request_id: z.string().min(1),
  session_id: z.string().min(1),
  agent_ids: z.array(z.string().min(1)).min(1).optional(),
});

export const responseMessageSchema = z.object({
  type: z.literal('response'),
  request_id: z.string(),
  code: z.number().int(),
  msg: z.string().optional(),
  task: taskStateSchema.optional(),
});

export type ResponseMessage = z.infer<typeof responseMessageSchema>;

export const pingMessageSchema = z.object({
  type: z.literal('ping'),
});

export const pongMessageSchema = z.object({
  type: z.literal('pong'),
});

export const sessionEventMessageSchema = wsEventEnvelopeSchema(pushEventSchema);

export type WsOperationDirection = 'client_to_server' | 'server_to_client';

export type WsOperationKind = 'control' | 'system' | 'event';

export interface WsOperationDefinition {
  readonly type: string;
  readonly direction: WsOperationDirection;
  readonly kind: WsOperationKind;
  readonly messageSchema: z.ZodTypeAny;
  readonly description: string;
}

export const clientControlOperations = [
  {
    type: 'subscribe',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: subscribeMessageSchema,
    description:
      'Start receiving agents of one session (agent_ids defaults to the main agent). The response comes first; then every newly added agent gets a turns frame with its latest page, or turns.failed when its conversation cannot be loaded, then turn, item and notice frames. The optional transcript and transcript_since fields attach the per-agent transcript operation stream. When the session cannot be opened, the response carries the error code and nothing is subscribed.',
  },
  {
    type: 'unsubscribe',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: unsubscribeMessageSchema,
    description:
      'Stop receiving agents or transcript operations of one session; without agent_ids the whole session is dropped.',
  },
  {
    type: 'task.watch',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: taskWatchMessageSchema,
    description:
      'Stream the output of one task owned by agent_id to this connection without a session subscription. The first chunk covers at most tail_bytes; since_offset resumes after output the client already has.',
  },
  {
    type: 'task.unwatch',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: taskUnwatchMessageSchema,
    description: "Stop streaming one task's output to this connection.",
  },
  {
    type: 'task.stop',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: taskStopMessageSchema,
    description:
      'Stop one task; the response carries its state, and an ended task just replies with it.',
  },
  {
    type: 'task.background',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: taskBackgroundMessageSchema,
    description:
      'Stop the tool call that started a task from waiting for it, so the task keeps running in the background; the response carries its state.',
  },
  {
    type: 'pong',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: pongMessageSchema,
    description: 'Reply to a server ping.',
  },
] as const satisfies readonly WsOperationDefinition[];

export const serverSystemOperations = [
  {
    type: 'response',
    direction: 'server_to_client',
    kind: 'system',
    messageSchema: responseMessageSchema,
    description:
      'Reply to one client command, matched by request_id; code 0 means success. Replies to task.watch, task.stop and task.background carry the task state. A command without a request_id closes the connection with code 1008.',
  },
  {
    type: 'ping',
    direction: 'server_to_client',
    kind: 'system',
    messageSchema: pingMessageSchema,
    description:
      'Heartbeat sent by the server every 10 seconds; clients answer with pong. The server closes a connection that sends nothing for 20 seconds, and a client that receives nothing for 25 seconds should reconnect.',
  },
] as const satisfies readonly WsOperationDefinition[];

export const sessionEventOperation = {
  type: 'session_event',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: sessionEventMessageSchema,
  description: 'Session-scoped agent event envelope; frame type is the payload event type.',
} as const satisfies WsOperationDefinition;

export const interactionEventOperation = {
  type: 'interaction',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: interactionEventMessageSchema,
  description:
    'Flat, unsequenced approval or question state for a subscribed session; pending interactions are re-sent after every accepted subscription.',
} as const satisfies WsOperationDefinition;

export const taskListEventOperation = {
  type: 'task.list',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: taskListMessageSchema,
  description:
    'Every task an agent is running right now, sent when a connection starts receiving that agent; it replaces the client list.',
} as const satisfies WsOperationDefinition;

export const taskEventOperation = {
  type: 'task',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: taskEventMessageSchema,
  description:
    'Full state of one task of a subscribed agent, sent on every change; the frame for an ended task is its last one.',
} as const satisfies WsOperationDefinition;

export const taskOutputEventOperation = {
  type: 'task.output',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: taskOutputMessageSchema,
  description:
    'Task output starting at a UTF-8 byte offset, sent only to connections watching the task.',
} as const satisfies WsOperationDefinition;

export const agentEventOperation = {
  type: 'agent',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: agentEventMessageSchema,
  description:
    'Status, model and mode flags of a subscribed agent; sent when a connection starts receiving it and on every change.',
} as const satisfies WsOperationDefinition;

export const usageEventOperation = {
  type: 'usage',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: usageEventMessageSchema,
  description: 'Context-window usage of a subscribed agent, throttled to one frame per interval.',
} as const satisfies WsOperationDefinition;

export const goalEventOperation = {
  type: 'goal',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: goalEventMessageSchema,
  description:
    "The main agent's goal state, or a frame without a goal when none is active; sent on every change.",
} as const satisfies WsOperationDefinition;

export const todoEventOperation = {
  type: 'todo',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: todoEventMessageSchema,
  description: 'The agent todo list as items, sent on every change.',
} as const satisfies WsOperationDefinition;

export const wsOperations = [
  ...clientControlOperations,
  ...serverSystemOperations,
  sessionEventOperation,
  interactionEventOperation,
  taskListEventOperation,
  taskEventOperation,
  taskOutputEventOperation,
  agentEventOperation,
  usageEventOperation,
  goalEventOperation,
  todoEventOperation,
] as const satisfies readonly WsOperationDefinition[];
