/**
 * `GET /auth` — readiness probe.
 *
 * Single readiness signal that web/IDE clients hit on first paint to decide
 * between onboarding vs. chat UI. Returns 200 + envelope regardless of provider
 * state.
 *
 * v2's `IAuthSummaryService.summarize()` returns a per-provider `AuthStatus[]`
 * (`{ loggedIn, provider? }`), which is a simpler model than the v1
 * `AuthSummary` wire shape (`{ ready, providers_count, default_model,
 * managed_provider }`). This handler projects the v2 snapshot onto the v1 wire
 * shape: `ready` reflects any authenticated provider, `providers_count` counts
 * the snapshot entries, `default_model` is `null` (v2 has no model catalog
 * yet), and `managed_provider` surfaces the authenticated provider when present.
 */

import { IAuthSummaryService, type Scope } from '@moonshot-ai/agent-core-v2';
import { authSummarySchema } from '@moonshot-ai/protocol';
import type { AuthSummary } from '@moonshot-ai/protocol';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

interface RouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerAuthRoute(app: RouteHost, core: Scope): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/auth',
      success: { data: authSummarySchema },
      description: 'Get server auth readiness snapshot',
      tags: ['auth'],
    },
    async (req, reply) => {
      const statuses = await core.accessor.get(IAuthSummaryService).summarize();
      const authenticated = statuses.find((s) => s.loggedIn);
      const firstNamed = statuses.find((s) => s.provider !== undefined);
      const summary: AuthSummary = {
        ready: authenticated !== undefined,
        providers_count: statuses.length,
        default_model: null,
        managed_provider: authenticated?.provider !== undefined
          ? { name: authenticated.provider, status: 'authenticated' }
          : firstNamed?.provider !== undefined
            ? { name: firstNamed.provider, status: 'unauthenticated' }
            : null,
      };
      reply.send(okEnvelope(summary, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
