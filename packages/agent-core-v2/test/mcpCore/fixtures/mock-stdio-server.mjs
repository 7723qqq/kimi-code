import { setTimeout as sleep } from 'node:timers/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const delayMs = Number.parseInt(process.env['KIMI_TEST_MCP_START_DELAY_MS'] ?? '0', 10);
if (delayMs > 0) {
  await sleep(delayMs);
}

const server = new McpServer({ name: 'mock-stdio', version: '0.0.1' });

server.registerTool(
  'echo',
  {
    description: 'Echoes input text',
    inputSchema: { text: z.string() },
  },
  ({ text }) => ({
    content: [{ type: 'text', text }],
  }),
);

server.registerTool(
  'boom',
  {
    description: 'Always returns an error result',
    inputSchema: {},
  },
  () => ({
    content: [{ type: 'text', text: 'boom!' }],
    isError: true,
  }),
);

server.registerTool(
  'read_env',
  {
    description: 'Returns the value of process.env[name], or empty string',
    inputSchema: { name: z.string() },
  },
  ({ name }) => ({
    content: [{ type: 'text', text: process.env[name] ?? '' }],
  }),
);

server.registerTool(
  'whoami',
  {
    description: 'Returns the client name announced during initialize',
    inputSchema: {},
  },
  () => ({
    content: [{ type: 'text', text: server.server.getClientVersion()?.name ?? '' }],
  }),
);

if (process.env['KIMI_TEST_MCP_VERBOSE_TOOL'] === '1') {
  server.registerTool(
    'verbose',
    {
      description: 'First sentence. Second sentence with extra detail.',
      inputSchema: {
        query: z.string().describe('Query the thing. Extra parameter detail.'),
        mode: z.enum(['fast', 'slow']).describe('Execution mode. Choose carefully.'),
      },
    },
    ({ query }) => ({
      content: [{ type: 'text', text: query }],
    }),
  );
}

const extraToolCount = Number.parseInt(process.env['KIMI_TEST_MCP_EXTRA_TOOLS'] ?? '0', 10);
for (let index = 0; index < extraToolCount; index += 1) {
  server.registerTool(
    `extra_${index}`,
    {
      description: `Extra test tool ${index}`,
      inputSchema: { text: z.string() },
    },
    ({ text }) => ({
      content: [{ type: 'text', text }],
    }),
  );
}

await server.connect(new StdioServerTransport());
