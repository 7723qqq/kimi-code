import { ErrorCodes, KimiError } from '@moonshot-ai/agent-core';

export function notImplemented(method: string): never {
  throw new KimiError(
    ErrorCodes.NOT_IMPLEMENTED,
    `KAP transport does not implement CoreAPI.${method} yet`,
  );
}
