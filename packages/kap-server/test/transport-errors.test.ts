import { describe, expect, it } from 'bun:test';

import { Error2, ErrorCodes } from '@moonshot-ai/agent-core-v2';

import { installErrorHandler } from '../src/error-handler';
import { ErrorCode } from '../src/protocol/error-codes';
import { mapDebugError, mapError } from '../src/transport/errors';

describe('ErrorCode', () => {
  it('has unique numeric values', () => {
    const values = Object.values(ErrorCode);
    expect(new Set(values).size).toBe(values.length);
  });

  it('distinguishes a missing turn from a missing agent on the wire', () => {
    expect(mapError(new Error2(ErrorCodes.TURN_NOT_FOUND, 'missing'), 'r1').code).toBe(40422);
    expect(mapError(new Error2(ErrorCodes.AGENT_NOT_FOUND, 'missing'), 'r2').code).toBe(40421);
  });
});

describe('/api/v1/debug transport mapError', () => {
  it.each([
    [ErrorCodes.OS_FS_NOT_FOUND, ErrorCode.FS_PATH_NOT_FOUND],
    [ErrorCodes.OS_FS_NOT_DIRECTORY, ErrorCode.FS_PATH_NOT_FOUND],
    [ErrorCodes.OS_FS_IS_DIRECTORY, ErrorCode.FS_IS_DIRECTORY],
    [ErrorCodes.OS_FS_ALREADY_EXISTS, ErrorCode.FS_ALREADY_EXISTS],
    [ErrorCodes.OS_FS_PERMISSION_DENIED, ErrorCode.FS_PERMISSION_DENIED],
    [ErrorCodes.STORAGE_IO_FAILED, ErrorCode.PERSISTENCE_FAILURE],
    [ErrorCodes.STORAGE_LOCKED, ErrorCode.PERSISTENCE_FAILURE],
    [ErrorCodes.CONFIG_PERSIST_BLOCKED, ErrorCode.PERSISTENCE_FAILURE],
    [ErrorCodes.CONFIG_INVALID, ErrorCode.VALIDATION_FAILED],
    [ErrorCodes.AGENT_NOT_FOUND, ErrorCode.AGENT_NOT_FOUND],
    [ErrorCodes.GOAL_UNSUPPORTED_AGENT, ErrorCode.GOAL_UNSUPPORTED_AGENT],
    [ErrorCodes.PROMPT_ID_CONFLICT, ErrorCode.PROMPT_ID_CONFLICT],
    [ErrorCodes.SESSION_TOWER_MODE_INVALID, ErrorCode.TOWER_MODE_INVALID],
    [ErrorCodes.MODEL_CONFIG_INVALID, ErrorCode.VALIDATION_FAILED],
    [ErrorCodes.AUTH_PROVISIONING_REQUIRED, ErrorCode.AUTH_PROVISIONING_REQUIRED],
    [ErrorCodes.AUTH_TOKEN_MISSING, ErrorCode.AUTH_TOKEN_MISSING],
    [ErrorCodes.AUTH_MODEL_NOT_RESOLVED, ErrorCode.AUTH_MODEL_NOT_RESOLVED],
  ])('maps domain code %s to its wire equivalent', (code, wire) => {
    const env = mapError(new Error2(code, 'boom'), 'req-1');
    expect(env.code).toBe(wire);
  });

  it('preserves session conflict details', () => {
    const details = { holder: { clientIdentity: 'other' } };
    const env = mapError(new Error2(ErrorCodes.SESSION_OCCUPIED, 'boom', { details }), 'req-1');
    expect(env.details).toEqual(details);
  });

  it('keeps the provider and model details of auth readiness errors', () => {
    const missing = mapError(
      new Error2(ErrorCodes.AUTH_TOKEN_MISSING, 'no key', { details: { provider_id: 'example' } }),
      'req-1',
    );
    expect(missing.details).toEqual({ provider_id: 'example' });
    const unresolved = mapError(
      new Error2(ErrorCodes.AUTH_MODEL_NOT_RESOLVED, 'no model', { details: { model_id: 'm1' } }),
      'req-1',
    );
    expect(unresolved.details).toEqual({ model_id: 'm1' });
  });

  it('never sends the server stack trace, except to debug callers', () => {
    const error = new Error2(ErrorCodes.OS_FS_UNKNOWN, 'boom');
    expect(mapError(error, 'req-1')).not.toHaveProperty('stack', expect.anything());
    expect(mapError(new Error('plain'), 'req-1')).not.toHaveProperty('stack', expect.anything());
    expect(mapDebugError(error, 'req-1').stack).toBe(error.stack);
  });

  it('falls back to INTERNAL_ERROR for coded errors without a wire equivalent', () => {
    const env = mapError(new Error2(ErrorCodes.OS_FS_UNKNOWN, 'boom'), 'req-1');
    expect(env.code).toBe(ErrorCode.INTERNAL_ERROR);
  });
});

describe('installErrorHandler (catch-all)', () => {
  function run(err: unknown): {
    status: number;
    body: { code: number; msg: string };
  } {
    let installed: unknown;
    installErrorHandler({
      setErrorHandler: (h) => {
        installed = h;
        return undefined;
      },
    });
    const handler = installed as (
      e: unknown,
      req: { id: string; log: { error: () => void } },
      reply: { status: (code: number) => { send: (p: unknown) => void } },
    ) => void;
    let status = 200;
    let body: { code: number; msg: string } | undefined;
    handler(
      err,
      { id: 'req-1', log: { error: () => {} } },
      {
        status: (code: number) => ({
          send: (p: unknown) => {
            status = code;
            body = p as typeof body;
          },
        }),
      },
    );
    return { status, body: body! };
  }

  it('maps an escaped config.invalid to VALIDATION_FAILED over HTTP 200', () => {
    const { status, body } = run(new Error2(ErrorCodes.CONFIG_INVALID, 'broken pool'));
    expect(status).toBe(200);
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(body.msg).toContain('broken pool');
  });

  it('keeps unknown exceptions at INTERNAL_ERROR without the stack trace', () => {
    const { status, body } = run(new Error('boom'));
    expect(status).toBe(200);
    expect(body.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(body.msg).toBe('boom');
    expect(body).not.toHaveProperty('stack', expect.anything());
  });
});
