/**
 * `/sessions/{session_id}/mcp*` REST routes — server-v2 additions.
 *
 * Exposes the session's MCP server connection view to the web UI:
 *
 *   GET  /sessions/{session_id}/mcp/servers                     data: {servers[]}
 *   POST /sessions/{session_id}/mcp/servers/{name}:reconnect    data: {reconnected:true}
 *
 * **Resolution**: `resumeSessionById` (cold-loads the session if needed) →
 * `ISessionMcpHandle` (Session scope seed contributed by the workspace MCP
 * service at session creation) → `connectionManager` (`McpConnectionView`:
 * `list()` / `reconnect(name)`). The handle is a pure-data seed; when it is
 * absent (a session created outside the workspace lifecycle) the routes answer
 * `40401` with a distinguishing message.
 *
 * **Status change notification**: the WS event stream already carries MCP
 * status changes — `McpConnectionManager.onStatusChange` is bridged into the
 * core event bus (see the mcpCore event bridge), so the UI can react to live
 * status without polling.
 */

import { ISessionMcpHandle, resumeSessionById, type Scope } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  listMcpServersResponseSchema,
  reconnectMcpResultSchema,
} from '../protocol/rest-mcp';
import { parseActionSuffix } from './action-suffix';

interface McpRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const sessionAndServerNameParamSchema = z.object({
  session_id: z.string().min(1),
  tail: z.string().min(1),
});

/**
 * Resolve the session's MCP connection view, or an error envelope when the
 * session is unknown or carries no MCP handle.
 */
async function resolveMcpView(core: Scope, sessionId: string, requestId: string) {
  const handle = await resumeSessionById(core.accessor, sessionId);
  if (handle === undefined) {
    return {
      envelope: errEnvelope(
        ErrorCode.SESSION_NOT_FOUND,
        `session ${sessionId} does not exist`,
        requestId,
      ),
    };
  }
  const mcp = handle.accessor.get(ISessionMcpHandle);
  if (mcp === undefined) {
    return {
      envelope: errEnvelope(
        ErrorCode.SESSION_NOT_FOUND,
        `session ${sessionId} has no MCP connection view`,
        requestId,
      ),
    };
  }
  return { view: mcp.connectionManager };
}

export function registerMcpRoutes(app: McpRouteHost, core: Scope): void {
  // GET /sessions/{session_id}/mcp/servers --------------------------------
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/mcp/servers',
      params: sessionIdParamSchema,
      success: { data: listMcpServersResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List the MCP servers connected to a session (name/transport/status/tools)',
      tags: ['mcp'],
      operationId: 'listMcpServers',
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const resolved = await resolveMcpView(core, session_id, req.id);
      if ('envelope' in resolved) {
        reply.send(resolved.envelope);
        return;
      }
      await resolved.view.waitForInitialLoad().catch(() => {});
      const servers = resolved.view.list().map((entry) => ({
        name: entry.name,
        transport: entry.transport,
        status: entry.status,
        tool_count: entry.toolCount,
        ...(entry.error !== undefined ? { error: entry.error } : {}),
      }));
      reply.send(okEnvelope({ servers }, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<McpRouteHost['get']>[2],
  );

  // POST /sessions/{session_id}/mcp/servers/{name}:reconnect --------------
  const reconnectRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/mcp/servers/{tail}',
      params: sessionAndServerNameParamSchema,
      success: { data: reconnectMcpResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Reconnect an MCP server (REST analogue of the :reconnect action)',
      tags: ['mcp'],
      operationId: 'reconnectMcpServer',
    },
    async (req, reply) => {
      const { session_id, tail } = req.params;
      const parsed = parseActionSuffix({
        tail,
        allowedActions: ['reconnect'] as const,
        resourceLabel: 'server_name',
      });
      if (parsed.kind === 'invalid') {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id));
        return;
      }
      if (parsed.kind === 'bare') {
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${tail}`, req.id),
        );
        return;
      }
      const resolved = await resolveMcpView(core, session_id, req.id);
      if ('envelope' in resolved) {
        reply.send(resolved.envelope);
        return;
      }
      if (resolved.view.get(parsed.id) === undefined) {
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, `unknown MCP server: ${parsed.id}`, req.id),
        );
        return;
      }
      try {
        await resolved.view.reconnect(parsed.id);
        requestLog(req)?.info({ server: parsed.id }, 'mcp server reconnected');
        reply.send(okEnvelope({ reconnected: true }, req.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        requestLog(req)?.error({ err: error, server: parsed.id }, 'mcp reconnect failed');
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
      }
    },
  );
  app.post(
    reconnectRoute.path,
    reconnectRoute.options,
    reconnectRoute.handler as Parameters<McpRouteHost['post']>[2],
  );
}
