/**
 *   Event:   { type, seq, session_id?, timestamp, payload }
 *   Control: { type, id?, payload }
 *   Ack:     { type: 'ack', id, code, msg, payload }
 */
import { z } from 'zod';

import { eventSchema } from './events';
import { isoDateTimeSchema } from './time';

/**
 * WS protocol version. v2 (breaking, IM-style multi-device sync):
 *   - per-session cursors are `{ seq, epoch }` instead of a bare seq
 *   - `seq` is durable (journal offset, survives daemon restarts)
 *   - volatile events carry `volatile: true` and do not advance `seq`
 *   - `resync_required` gains the `epoch_changed` reason + `epoch` field
 */
export const WS_PROTOCOL_VERSION = 2;

/**
 * Per-session sync cursor. `seq` is the last durable event seq the client
 * has applied (journal offset). `epoch` identifies the journal incarnation
 * (changes when a session's journal is recreated); a cursor whose epoch does
 * not match the server's current epoch is invalid and triggers
 * `resync_required(epoch_changed)`. `epoch` is absent on a fresh cursor.
 */
export const sessionCursorSchema = z.object({
  seq: z.number().int().nonnegative(),
  epoch: z.string().min(1).optional(),
});

export type SessionCursor = z.infer<typeof sessionCursorSchema>;

export const cursorsBySessionSchema = z.record(z.string(), sessionCursorSchema);

export type CursorsBySession = z.infer<typeof cursorsBySessionSchema>;

export const wsEventEnvelopeSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    type: z.string(),
    seq: z.number().int().nonnegative(),
    epoch: z.string().optional(),
    volatile: z.boolean().optional(),
    /**
     * For volatile text-delta frames (`assistant.delta` / `thinking.delta`):
     * the cumulative character offset of this delta within the in-flight
     * turn's accumulated stream. Clients align against
     * `snapshot.in_flight_turn.*_text.length` — `offset < local length` is a
     * duplicate (skip), `offset > local length` means deltas were missed
     * (re-snapshot).
     */
    offset: z.number().int().nonnegative().optional(),
    session_id: z.string().optional(),
    timestamp: isoDateTimeSchema,
    payload,
  });

export const wsControlEnvelopeSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    type: z.string(),
    id: z.string().optional(),
    payload,
  });

export const wsAckEnvelopeSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    type: z.literal('ack'),
    id: z.string(),
    code: z.number().int(),
    msg: z.string(),
    payload,
  });

export const serverHelloPayloadSchema = z.object({
  ws_connection_id: z.string(),
  protocol_version: z.number().int().positive(),
  heartbeat_ms: z.number().int().positive(),
  max_event_buffer_size: z.number().int().positive(),
  capabilities: z.object({
    event_batching: z.boolean(),
    compression: z.boolean(),
  }),
});

export const serverHelloMessageSchema = z.object({
  type: z.literal('server_hello'),
  timestamp: isoDateTimeSchema,
  payload: serverHelloPayloadSchema,
});

export type ServerHelloMessage = z.infer<typeof serverHelloMessageSchema>;

export const clientHelloPayloadSchema = z.object({
  client_id: z.string(),
  subscriptions: z.array(z.string()),
  cursors: cursorsBySessionSchema.optional(),
});

export const clientHelloMessageSchema = z.object({
  type: z.literal('client_hello'),
  id: z.string(),
  payload: clientHelloPayloadSchema,
});

export type ClientHelloMessage = z.infer<typeof clientHelloMessageSchema>;

export const clientHelloAckPayloadSchema = z.object({
  accepted_subscriptions: z.array(z.string()),
  resync_required: z.array(z.string()),
  /** Server-side current cursor per accepted session ({seq, epoch}). */
  cursors: cursorsBySessionSchema.optional(),
});

export const helloAckPayloadSchema = clientHelloAckPayloadSchema;

export const clientHelloAckMessageSchema = wsAckEnvelopeSchema(clientHelloAckPayloadSchema);

export const watchFsConfigSchema = z.object({
  paths: z.array(z.string()),
  recursive: z.boolean().optional(),
});

export const subscribePayloadSchema = z.object({
  session_ids: z.array(z.string()),
  cursors: cursorsBySessionSchema.optional(),
  watch_fs: z.record(z.string(), watchFsConfigSchema).optional(),
});

export const subscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  id: z.string(),
  payload: subscribePayloadSchema,
});

export type SubscribeMessage = z.infer<typeof subscribeMessageSchema>;

export const subscribeAckPayloadSchema = z.object({
  accepted: z.array(z.string()),
  not_found: z.array(z.string()),
  resync_required: z.array(z.string()),
  /** Server-side current cursor per accepted session ({seq, epoch}). */
  cursors: cursorsBySessionSchema.optional(),
});

export const subscribeAckMessageSchema = wsAckEnvelopeSchema(subscribeAckPayloadSchema);

export const unsubscribePayloadSchema = z.object({
  session_ids: z.array(z.string()),
});

export const unsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  id: z.string(),
  payload: unsubscribePayloadSchema,
});

export type UnsubscribeMessage = z.infer<typeof unsubscribeMessageSchema>;

export const unsubscribeAckPayloadSchema = subscribeAckPayloadSchema;

export const unsubscribeAckMessageSchema = wsAckEnvelopeSchema(unsubscribeAckPayloadSchema);

export const watchFsAddPayloadSchema = z.object({
  session_id: z.string(),
  paths: z.array(z.string()),
  recursive: z.boolean().optional(),
});

export const watchFsAddMessageSchema = z.object({
  type: z.literal('watch_fs_add'),
  id: z.string(),
  payload: watchFsAddPayloadSchema,
});

export type WatchFsAddMessage = z.infer<typeof watchFsAddMessageSchema>;

export const watchFsRemovePayloadSchema = z.object({
  session_id: z.string(),
  paths: z.array(z.string()),
});

export const watchFsRemoveMessageSchema = z.object({
  type: z.literal('watch_fs_remove'),
  id: z.string(),
  payload: watchFsRemovePayloadSchema,
});

export type WatchFsRemoveMessage = z.infer<typeof watchFsRemoveMessageSchema>;

export const watchFsAckPayloadSchema = z.object({
  watched_paths: z.array(z.string()).optional(),
  current_count: z.number().int().nonnegative().optional(),
});

export const watchFsAckMessageSchema = wsAckEnvelopeSchema(watchFsAckPayloadSchema);

export const abortPayloadSchema = z.object({
  session_id: z.string(),
  prompt_id: z.string(),
});

export const abortMessageSchema = z.object({
  type: z.literal('abort'),
  id: z.string(),
  payload: abortPayloadSchema,
});

export type AbortMessage = z.infer<typeof abortMessageSchema>;

export const abortAckPayloadSchema = z.object({
  aborted: z.boolean().optional(),
  at_seq: z.number().int().nonnegative().optional(),
});

export const abortAckMessageSchema = wsAckEnvelopeSchema(abortAckPayloadSchema);

export const pingPayloadSchema = z.object({
  nonce: z.string(),
});

export const pingMessageSchema = z.object({
  type: z.literal('ping'),
  timestamp: isoDateTimeSchema,
  payload: pingPayloadSchema,
});

export type PingMessage = z.infer<typeof pingMessageSchema>;

export const pongPayloadSchema = z.object({
  nonce: z.string(),
});

export const pongMessageSchema = z.object({
  type: z.literal('pong'),
  payload: pongPayloadSchema,
});

export type PongMessage = z.infer<typeof pongMessageSchema>;

export const resyncRequiredPayloadSchema = z.object({
  session_id: z.string(),
  reason: z.enum(['buffer_overflow', 'session_recreated', 'epoch_changed']),
  current_seq: z.number().int().nonnegative(),
  /** Current journal epoch — the client should adopt it after resyncing. */
  epoch: z.string().min(1).optional(),
});

export const resyncRequiredMessageSchema = z.object({
  type: z.literal('resync_required'),
  timestamp: isoDateTimeSchema,
  payload: resyncRequiredPayloadSchema,
});

export type ResyncRequiredMessage = z.infer<typeof resyncRequiredMessageSchema>;

export const wsErrorPayloadSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
  fatal: z.boolean(),
  request_id: z.string().optional(),
  details: z.unknown().optional(),
});

export const wsErrorMessageSchema = z.object({
  type: z.literal('error'),
  timestamp: isoDateTimeSchema,
  payload: wsErrorPayloadSchema,
});

export type WsErrorMessage = z.infer<typeof wsErrorMessageSchema>;

export const sessionEventMessageSchema = wsEventEnvelopeSchema(eventSchema);

export const clientControlMessageSchema = z.discriminatedUnion('type', [
  clientHelloMessageSchema,
  subscribeMessageSchema,
  unsubscribeMessageSchema,
  watchFsAddMessageSchema,
  watchFsRemoveMessageSchema,
  abortMessageSchema,
  pongMessageSchema,
]);

export type ClientControlMessage = z.infer<typeof clientControlMessageSchema>;

export const serverSystemMessageSchema = z.discriminatedUnion('type', [
  serverHelloMessageSchema,
  pingMessageSchema,
  resyncRequiredMessageSchema,
  wsErrorMessageSchema,
]);

export type ServerSystemMessage = z.infer<typeof serverSystemMessageSchema>;

export type WsOperationDirection = 'client_to_server' | 'server_to_client';

export type WsOperationKind = 'control' | 'system' | 'event';

export interface WsOperationDefinition {
  readonly type: string;
  readonly direction: WsOperationDirection;
  readonly kind: WsOperationKind;
  readonly messageSchema: z.ZodTypeAny;
  readonly ackSchema?: z.ZodTypeAny;
  readonly description: string;
}

export const clientControlOperations = [
  {
    type: 'client_hello',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: clientHelloMessageSchema,
    ackSchema: clientHelloAckMessageSchema,
    description: 'Start a client session and optionally subscribe to existing daemon sessions.',
  },
  {
    type: 'subscribe',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: subscribeMessageSchema,
    ackSchema: subscribeAckMessageSchema,
    description: 'Subscribe the connection to one or more session event streams.',
  },
  {
    type: 'unsubscribe',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: unsubscribeMessageSchema,
    ackSchema: unsubscribeAckMessageSchema,
    description: 'Remove one or more session event stream subscriptions.',
  },
  {
    type: 'watch_fs_add',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: watchFsAddMessageSchema,
    ackSchema: watchFsAckMessageSchema,
    description: 'Add filesystem watch paths for a subscribed session.',
  },
  {
    type: 'watch_fs_remove',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: watchFsRemoveMessageSchema,
    ackSchema: watchFsAckMessageSchema,
    description: 'Remove filesystem watch paths for a subscribed session.',
  },
  {
    type: 'abort',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: abortMessageSchema,
    ackSchema: abortAckMessageSchema,
    description: 'Abort a running prompt in a session.',
  },
  {
    type: 'pong',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: pongMessageSchema,
    description: 'Reply to a server ping with the same nonce.',
  },
] as const satisfies readonly WsOperationDefinition[];

export const serverSystemOperations = [
  {
    type: 'server_hello',
    direction: 'server_to_client',
    kind: 'system',
    messageSchema: serverHelloMessageSchema,
    description: 'Initial server greeting sent immediately after the socket opens.',
  },
  {
    type: 'ping',
    direction: 'server_to_client',
    kind: 'system',
    messageSchema: pingMessageSchema,
    description: 'Heartbeat ping sent by the server; clients must answer with pong.',
  },
  {
    type: 'resync_required',
    direction: 'server_to_client',
    kind: 'system',
    messageSchema: resyncRequiredMessageSchema,
    description: 'Signals that a client must rebuild local session state from REST history.',
  },
  {
    type: 'error',
    direction: 'server_to_client',
    kind: 'system',
    messageSchema: wsErrorMessageSchema,
    description: 'Server-side WebSocket protocol or runtime error.',
  },
] as const satisfies readonly WsOperationDefinition[];

export const sessionEventOperation = {
  type: 'session_event',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: sessionEventMessageSchema,
  description: 'Session-scoped agent event envelope; frame type is the payload event type.',
} as const satisfies WsOperationDefinition;

export const wsOperations = [
  ...clientControlOperations,
  ...serverSystemOperations,
  sessionEventOperation,
] as const satisfies readonly WsOperationDefinition[];

export function getClientControlOperation(
  type: string,
): (typeof clientControlOperations)[number] | undefined {
  return clientControlOperations.find((operation) => operation.type === type);
}
