import type { CoreAPI, RPCMethods } from '@moonshot-ai/agent-core';

import { notImplemented } from './not-implemented';
import type { CoreApiHandlerMap, CoreProxyContext } from './types';

/**
 * Build a `RPCMethods<CoreAPI>`-shaped proxy backed by a handler registry.
 * Any CoreAPI method without a registered handler throws `NOT_IMPLEMENTED`,
 * which is what lets the migration land phase-by-phase while staying runnable.
 */
export function buildCoreApiProxy(
  handlers: CoreApiHandlerMap,
  ctx: CoreProxyContext,
): RPCMethods<CoreAPI> {
  return new Proxy({} as Record<PropertyKey, unknown>, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') {
        return undefined;
      }
      const handler = handlers[prop as keyof CoreAPI];
      return async (payload: unknown) => {
        if (handler === undefined) {
          notImplemented(prop);
        }
        return handler(payload, ctx);
      };
    },
  }) as RPCMethods<CoreAPI>;
}
