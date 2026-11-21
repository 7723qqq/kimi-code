import { ErrorCodes, Error2, isError2 } from '@moonshot-ai/agent-core-v2';

import { errEnvelope } from './envelope';
import { ErrorCode } from './protocol/error-codes';
import type { FastifyError } from 'fastify';

interface ErrorHandlerHost {
  setErrorHandler(
    handler: (
      err: FastifyError,
      req: { id: string; log: { error: (obj: object | string, msg?: string) => void } },
      reply: { status(code: number): { send(payload: unknown): void } },
    ) => void,
  ): unknown;
}

export function installErrorHandler(app: ErrorHandlerHost): void {
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    // Bind with an explicit `Error2` type: narrowing `FastifyError` in place
    // keeps the merged-interface type, so `details` is not visible on it.
    const coded: Error2 | undefined = isError2(err) ? err : undefined;
    if (coded !== undefined && coded.code === ErrorCodes.CONFIG_INVALID) {
      reply
        .status(200)
        .send(errEnvelope(ErrorCode.VALIDATION_FAILED, coded.message, requestId));
      return;
    }
    if (coded !== undefined && coded.code === ErrorCodes.WIRE_VERSION_TOO_LOW) {
      reply
        .status(200)
        .send(
          errEnvelope(
            ErrorCode.WIRE_VERSION_TOO_LOW,
            coded.message,
            requestId,
            coded.details,
          ),
        );
      return;
    }
    req.log.error({ err, request_id: requestId }, 'unhandled error');
    reply.status(200).send(
      errEnvelope(
        ErrorCode.INTERNAL_ERROR,
        err.message !== undefined && err.message !== '' ? err.message : 'internal error',
        requestId,
      ),
    );
  });
}
