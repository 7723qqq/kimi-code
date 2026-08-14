/**
 * Wire schemas for the `/sessions/{session_id}/mcp*` REST surface — the
 * session's MCP server connection view (`ISessionMcpHandle.connectionManager`).
 *
 *   GET  /sessions/{session_id}/mcp/servers                       data: {servers[]}
 *   POST /sessions/{session_id}/mcp/servers/{name}:reconnect      data: {reconnected:true}
 */

import { z } from 'zod';

export const mcpServerStatusSchema = z.enum([
  'pending',
  'pending-approval',
  'connected',
  'failed',
  'disabled',
  'needs-auth',
  'removed',
]);
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;

export const mcpServerEntrySchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'http', 'sse']),
  status: mcpServerStatusSchema,
  tool_count: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type McpServerEntry = z.infer<typeof mcpServerEntrySchema>;

export const listMcpServersResponseSchema = z.object({
  servers: z.array(mcpServerEntrySchema),
});
export type ListMcpServersResponse = z.infer<typeof listMcpServersResponseSchema>;

export const reconnectMcpResultSchema = z.object({
  reconnected: z.literal(true),
});
export type ReconnectMcpResult = z.infer<typeof reconnectMcpResultSchema>;
