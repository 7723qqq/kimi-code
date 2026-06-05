/**
 * `/tools` + `/mcp/servers*` REST routes (Chain 7 / P1.7, W9.1).
 *
 * 3 endpoints (REST.md §3.8):
 *
 *   GET  /tools                                  query: {session_id?}    data: {tools: ToolDescriptor[]}
 *   GET  /mcp/servers                            -                       data: {servers: McpServer[]}
 *   POST /mcp/servers/{mcp_server_id}:restart    body: empty             data: {restarting: true}
 *
 * **Error mapping**:
 *   - `McpServerNotFoundError` → envelope `code: 40408 mcp.server_not_found`.
 *   - Other errors → 50001 via W4 `installErrorHandler`.
 *
 * **Action suffix**: the `:restart` POST endpoint uses the shared
 * `parseActionSuffix` helper (extracted W9.1, 4th call site after prompts:abort,
 * questions:resolve, questions:dismiss).
 *
 * **Anti-corruption**: route resolves `IToolService` / `IMcpService` via the
 * accessor; no SDK imports.
 */

import {
  ErrorCode,
  listMcpServersResponseSchema,
  listToolsQuerySchema,
  listToolsResponseSchema,
  restartMcpServerResultSchema,
  type ListToolsQuery,
} from '@moonshot-ai/protocol';
import { IMcpService, IToolService, McpServerNotFoundError } from '@moonshot-ai/services';
import { z } from 'zod';

import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope.js';
import { buildRouteSchema } from '../middleware/schema.js';
import { validateQuery } from '../middleware/validate.js';
import { parseActionSuffix } from './action-suffix.js';

interface ToolsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerToolsRoutes(
  app: ToolsRouteHost,
  ix: IInstantiationService,
): void {
  // GET /tools ----------------------------------------------------------
  app.get(
    '/tools',
    {
      preHandler: [validateQuery(listToolsQuerySchema)],
      schema: buildRouteSchema({
        description: 'List available tools',
        tags: ['tools'],
        querystring: listToolsQuerySchema,
        response: { 200: listToolsResponseSchema },
      }),
    },
    async (req, reply) => {
      try {
        const query = req.query as ListToolsQuery;
        const tools = await ix.invokeFunction((a) =>
          a.get(IToolService).list(query.session_id),
        );
        reply.send(okEnvelope({ tools }, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  // GET /mcp/servers ----------------------------------------------------
  app.get('/mcp/servers', {
    preHandler: [],
    schema: buildRouteSchema({
      description: 'List configured MCP servers',
      tags: ['tools'],
      response: { 200: listMcpServersResponseSchema },
    }),
  }, async (req, reply) => {
    try {
      const servers = await ix.invokeFunction((a) => a.get(IMcpService).list());
      reply.send(okEnvelope({ servers }, req.id));
    } catch (err) {
      sendMappedError(reply, req.id, err);
    }
  });

  // POST /mcp/servers/{mcp_server_id}:restart ---------------------------
  app.post(
    '/mcp/servers/:tail',
    {
      preHandler: [],
      schema: buildRouteSchema({
        description: 'Restart an MCP server by ID',
        tags: ['tools'],
        operationId: 'restartMcpServer',
        response: { 200: restartMcpServerResultSchema },
      }),
    },
    async (req, reply) => {
      try {
        const { tail } = req.params as { tail: string };
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['restart'] as const,
          resourceLabel: 'mcp_server',
        });
        if (parsed.kind === 'invalid') {
          reply.send(
            errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id),
          );
          return;
        }
        if (parsed.kind === 'bare') {
          // No bare form for /mcp/servers/{id} — only :restart.
          reply.send(
            errEnvelope(
              ErrorCode.VALIDATION_FAILED,
              `unsupported action: ${tail}`,
              req.id,
            ),
          );
          return;
        }
        const result = await ix.invokeFunction((a) =>
          a.get(IMcpService).restart(parsed.id),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
}

/**
 * Map a thrown error to the right envelope. See module header for the table.
 */
function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof McpServerNotFoundError) {
    reply.send(errEnvelope(ErrorCode.MCP_SERVER_NOT_FOUND, err.message, requestId));
    return;
  }
  throw err;
}

// Reference `z` so eslint doesn't flag the import — currently unused beyond
// the schema's downstream consumers, but kept for future params validation.
void z;
