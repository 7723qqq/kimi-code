// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import McpAuthorizationTool from '../src/chat/tool-calls/McpAuthorizationTool.vue';
import { resolveToolRenderer } from '../src/chat/tool-calls/toolRegistry';

let app: App | null = null;
let host: HTMLDivElement;

function mount(tool: Partial<ToolCall>): void {
  const i18n = createKimiI18n({ locale: 'en' });
  app = createApp({
    setup: () => () =>
      h(McpAuthorizationTool, {
        tool: {
          id: 'call_1',
          name: 'mcp__example__authenticate',
          arg: '{}',
          status: 'running',
          startedAt: new Date().toISOString(),
          ...tool,
        } as ToolCall,
      }),
  });
  app.use(i18n);
  app.mount(host);
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

describe('McpAuthorizationTool', () => {
  it('renders the waiting phase with the authorization link and actions', async () => {
    const request = {
      serverName: 'example',
      waitId: 'wait-1',
      authorizationUrl: 'https://auth.example.test/authorize?state=test',
      expiresAt: Date.now() + 60_000,
    };
    mount({
      status: 'running',
      mcpAuth: { phase: 'waiting', serverName: 'example', request },
    });
    await nextTick();

    expect(host.textContent).toContain('Authorize example in your browser.');
    expect(host.querySelector('a')?.getAttribute('href')).toBe(request.authorizationUrl);
    expect(host.textContent).toContain('Open authorization page');
    expect(host.textContent).toContain('Copy link');
  });

  it('renders the terminal phases without an authorization link', async () => {
    mount({ status: 'ok', mcpAuth: { phase: 'connected', serverName: 'example' } });
    await nextTick();

    expect(host.textContent).toContain('Connected to example.');
    expect(host.querySelector('a')).toBeNull();
  });

  it('is selected by the tool registry when the call carries an MCP auth card', () => {
    const renderer = resolveToolRenderer({
      id: 'call_1',
      name: 'mcp__example__authenticate',
      arg: '{}',
      status: 'running',
      mcpAuth: { phase: 'connected', serverName: 'example' },
    });
    expect(renderer).toBe(McpAuthorizationTool);
  });
});
