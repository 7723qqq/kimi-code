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

export const mcpToolSchema = z.object({
  name: z.string(),
  description: z.string(),
});
export type McpTool = z.infer<typeof mcpToolSchema>;

/** Detail view of one server: entry fields + the resolved tool list. */
export const mcpServerDetailSchema = mcpServerEntrySchema.extend({
  tools: z.array(mcpToolSchema),
});
export type McpServerDetail = z.infer<typeof mcpServerDetailSchema>;

export const reconnectMcpResultSchema = z.object({
  reconnected: z.literal(true),
});
export type ReconnectMcpResult = z.infer<typeof reconnectMcpResultSchema>;
