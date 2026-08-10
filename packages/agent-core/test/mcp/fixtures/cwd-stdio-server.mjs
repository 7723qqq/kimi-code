import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

// Minimal MCP stdio server fixture for cwd assertions.
// Exposes:
//   - get_cwd() -> the server process cwd
const server = new McpServer({ name: 'cwd-stdio', version: '0.0.1' });

server.registerTool(
  'get_cwd',
  {
    description: 'Returns the server process cwd',
    inputSchema: z.object({}),
  },
  () => ({
    content: [{ type: 'text', text: process.cwd() }],
  }),
);

await server.connect(new StdioServerTransport());
