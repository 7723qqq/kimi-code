import type { MCPServerConfig } from 'shared/legacy-sdk';

import { t } from '@/i18n';

export interface RecommendedMCPServer {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  github?: string;
}

// Built per call, not at module scope: `t()` has to run under the active
// locale, and a module-level constant would freeze whichever locale happened
// to be installed when the bundle was first evaluated.
export function recommendedMcpServers(): RecommendedMCPServer[] {
  return [
    {
      id: 'playwright',
      name: 'Playwright',
      description: t('recommendedMcp.playwrightDescription'),
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest', '--allow-unrestricted-file-access'],
      github: 'https://github.com/microsoft/playwright-mcp',
    },
    {
      id: 'context7',
      name: 'Context7',
      description: t('recommendedMcp.context7Description'),
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest'],
      github: 'https://github.com/upstash/context7',
    },
    {
      id: 'github',
      name: 'GitHub',
      description: t('recommendedMcp.githubDescription'),
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github@latest'],
      github: 'https://github.com/modelcontextprotocol/servers',
    },
  ];
}

export function recommendedToConfig(server: RecommendedMCPServer): MCPServerConfig {
  return {
    name: server.id,
    transport: 'stdio',
    command: server.command,
    args: server.args,
  };
}
