import { setTimeout as sleep } from 'node:timers/promises';

import { McpServer } from '@modelcontextprotocol/server';
// initialize handshake so startupTimeoutMs in McpConnectionManager fires.
// Simulates a slow-starting MCP server: sleeps before completing the
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const delayMs = Number.parseInt(process.env['KIMI_TEST_MCP_START_DELAY_MS'] ?? '2000', 10);
await sleep(delayMs);

const server = new McpServer({ name: 'slow-stdio', version: '0.0.1' });

server.registerTool(
  'echo',
  {
    description: 'Echoes input text',
    inputSchema: z.object({ text: z.string() }),
  },
  ({ text }) => ({
    content: [{ type: 'text', text }],
  }),
);

await server.connect(new StdioServerTransport());
