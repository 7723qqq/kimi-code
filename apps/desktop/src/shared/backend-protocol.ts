import { z } from 'zod';

import { BROWSER_ERROR_CODES, BROWSER_OPERATIONS } from './browser-automation';
import {
  BROWSER_DIALOG_RECORD_ANSWERERS,
  BROWSER_DIALOG_RECORD_KINDS,
  BROWSER_DIALOG_RECORD_OUTCOMES,
  BROWSER_PAGE_DIALOG_KINDS,
} from './browser-dialogs';

export const BACKEND_PROTOCOL_VERSION = 1;
export const BACKEND_MAX_FRAME_BYTES = 12 * 1024 * 1024;

const id = z.int().positive();
const identity = z.string().min(1).max(256);
const path = z
  .string()
  .min(1)
  .max(32768)
  .refine((value) => !value.includes('\0'));
const port = z.int().min(1).max(65535);
const secret = z
  .string()
  .min(24)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
const run = z.strictObject({
  agentId: identity,
  generation: z.int().nonnegative(),
  turnId: z.int().nonnegative(),
});
const controller = z.strictObject({
  run,
  profile: z.string().max(500).optional(),
  description: z.string().max(500).optional(),
});
const settings = z.strictObject({
  revision: z.int().nonnegative(),
  agent: z.boolean(),
  subagent: z.boolean(),
});
const loopbackOrigin = z.templateLiteral(['http://127.0.0.1:', z.number()]);
const operation = z.enum(BROWSER_OPERATIONS).or(z.literal('unknown'));
const errorCode = z.enum([
  ...BROWSER_ERROR_CODES,
  'CONTROL_DISABLED',
  'INVALID_ARGS',
  'SUBAGENT_RUN_INVALID',
  'UNKNOWN_TOOL',
]);
const strings = z.array(z.string()).max(64);
const pendingDialog = z.strictObject({
  dialogId: identity,
  tabId: identity,
  kind: z.enum(BROWSER_PAGE_DIALOG_KINDS),
  origin: z.string(),
  message: z.string(),
  defaultValue: z.string().optional(),
  answerer: z.enum(['agent', 'user']),
  accept: strings.optional(),
  multiple: z.boolean().optional(),
  files: strings.optional(),
  target: z.string().optional(),
  retryAfterAccept: z.literal(true).optional(),
  ageMs: z.number(),
});
const handledDialog = z.strictObject({
  id: identity,
  tabId: identity,
  kind: z.enum(BROWSER_DIALOG_RECORD_KINDS),
  origin: z.string(),
  message: z.string().optional(),
  text: z.string().optional(),
  outcome: z.enum(BROWSER_DIALOG_RECORD_OUTCOMES),
  answerer: z.enum(BROWSER_DIALOG_RECORD_ANSWERERS),
  openedAt: z.number(),
  settledAt: z.number(),
  files: strings.optional(),
  downloadId: identity.optional(),
});
const dialogReminder = z.strictObject({
  tabs: z.array(
    z.strictObject({ tabId: identity, title: z.string().max(200), url: z.string().max(512) }),
  ),
  pendingDialogs: z.array(pendingDialog),
  handledDialogs: z.array(handledDialog),
  more: z.boolean(),
});
const browserResult = z.strictObject({
  operation,
  errorCode: errorCode.optional(),
  text: z.string(),
  image: z
    .strictObject({ data: z.string(), mimeType: z.enum(['image/png', 'image/jpeg']) })
    .optional(),
});
const telemetryProps = z
  .record(z.string().min(1).max(128), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .optional();

export const backendMethods = {
  start: {
    receiver: 'bun',
    input: z.strictObject({
      homeDir: path,
      webAssetsDir: path.optional(),
      searchWorkerPath: path.optional(),
      textBuildWorkerPath: path.optional(),
      serverVersion: identity,
      hostIdentity: z.strictObject({
        productName: identity,
        platform: identity,
        version: identity,
        displayName: identity,
        replyStyleGuide: z.string().min(1).max(8192),
        userAgentSuffix: identity.optional(),
      }),
      deviceId: identity,
      devOrigin: z
        .string()
        .max(512)
        .refine((value) => {
          try {
            const url = new URL(value);
            return (
              url.origin === value &&
              ['http:', 'https:'].includes(url.protocol) &&
              ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
            );
          } catch {
            return false;
          }
        })
        .optional(),
      debugEndpoints: z.boolean(),
      authSecret: secret,
      browserMcpTestToken: secret.optional(),
      browser: settings,
    }),
    output: z
      .strictObject({
        origin: loopbackOrigin,
        port,
        browserMcpPort: port,
        runtime: z.strictObject({ name: z.literal('bun'), version: identity }),
        telemetry: z.boolean(),
      })
      .refine(({ origin, port: boundPort }) => origin === `http://127.0.0.1:${boundPort}`),
  },
  shutdown: { receiver: 'bun', input: z.null(), output: z.null() },
  'browser.validate-owner': {
    receiver: 'bun',
    input: z.strictObject({
      sessionId: identity,
      owner: run,
      settingsRevision: z.int().nonnegative(),
    }),
    output: z.boolean(),
  },
  'telemetry.shutdown': { receiver: 'bun', input: z.null(), output: z.null() },
  'telemetry.first-launch': { receiver: 'bun', input: z.null(), output: z.boolean() },
  'telemetry.session-count': { receiver: 'bun', input: z.null(), output: z.int().nonnegative() },
  'browser.run': {
    receiver: 'electron',
    input: z.strictObject({
      args: z
        .json()
        .transform((value): unknown => value)
        .optional(),
      sessionId: identity.optional(),
      owner: run.optional(),
      controller: controller.optional(),
      settingsRevision: z.int().nonnegative(),
    }),
    output: browserResult,
  },
  'browser.collect-dialogs': {
    receiver: 'electron',
    input: z.strictObject({ sessionId: identity }),
    output: dialogReminder.nullable(),
  },
} as const;

export const backendEvents = {
  'browser.settings': { receiver: 'bun', payload: settings },
  'browser.revoke-run': {
    receiver: 'electron',
    payload: z.strictObject({ sessionId: identity, run, settingChange: z.boolean() }),
  },
  'browser.restore-runs': {
    receiver: 'electron',
    payload: z.strictObject({ settingsRevision: z.int().nonnegative() }),
  },
  'browser.forget-dialogs': {
    receiver: 'electron',
    payload: z.strictObject({ sessionId: identity }),
  },
  'telemetry.record': {
    receiver: 'bun',
    payload: z.strictObject({
      event: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z0-9_]+$/),
      properties: telemetryProps,
    }),
  },
  'telemetry.browser-operation': {
    receiver: 'electron',
    payload: z.strictObject({
      operation,
      ok: z.boolean(),
      error_code: errorCode.optional(),
      duration_ms: z.number().nonnegative(),
      caller: z.enum(['main', 'subagent']),
      session_id: identity.optional(),
    }),
  },
  'telemetry.browser-reconnect': {
    receiver: 'electron',
    payload: z.strictObject({
      reason: z.enum(['session_create', 'setting_change']),
      retried: z.boolean(),
      ok: z.boolean(),
      session_id: identity.optional(),
    }),
  },
} as const;

export type BackendMethod = keyof typeof backendMethods;
export type BackendInput<M extends BackendMethod> = z.output<(typeof backendMethods)[M]['input']>;
export type BackendOutput<M extends BackendMethod> = z.output<(typeof backendMethods)[M]['output']>;
export type BackendEvent = keyof typeof backendEvents;
export type BackendEventPayload<E extends BackendEvent> = z.output<
  (typeof backendEvents)[E]['payload']
>;
export type BrowserDialogReminder = z.output<typeof dialogReminder>;

const version = z.literal(BACKEND_PROTOCOL_VERSION);
const wireError = z.strictObject({
  code: z.enum([
    'cancelled',
    'closing',
    'not_ready',
    'request_failed',
    'startup_failed',
    'shutdown_failed',
  ]),
  message: z.string().min(1).max(512),
});
export type BackendWireError = z.output<typeof wireError>;
const frame = z.union([
  z.strictObject({
    version,
    type: z.literal('request'),
    id,
    method: z.string(),
    input: z.unknown(),
  }),
  z.strictObject({
    version,
    type: z.literal('result'),
    id,
    ok: z.literal(true),
    value: z.unknown(),
  }),
  z.strictObject({
    version,
    type: z.literal('result'),
    id,
    ok: z.literal(false),
    error: wireError,
  }),
  z.strictObject({ version, type: z.literal('cancel'), id }),
  z.strictObject({ version, type: z.literal('event'), name: z.string(), payload: z.unknown() }),
  z.strictObject({ version, type: z.literal('protocol-error') }),
]);
export type BackendFrame = z.output<typeof frame>;

export class BackendProtocolError extends Error {
  override readonly name = 'BackendProtocolError';
}

export class BackendRequestError extends Error {
  override readonly name = 'BackendRequestError';

  constructor(
    readonly code: BackendWireError['code'],
    message: string,
  ) {
    super(message);
  }
}

export function parseBackendFrame(line: string): BackendFrame {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    throw new BackendProtocolError('Invalid Desktop backend JSON');
  }
  if (
    typeof decoded === 'object' &&
    decoded !== null &&
    'version' in decoded &&
    decoded.version !== BACKEND_PROTOCOL_VERSION
  ) {
    throw new BackendProtocolError('Unsupported Desktop backend protocol version');
  }
  const parsed = frame.safeParse(decoded);
  if (!parsed.success) throw new BackendProtocolError('Malformed Desktop backend frame');
  return parsed.data;
}
