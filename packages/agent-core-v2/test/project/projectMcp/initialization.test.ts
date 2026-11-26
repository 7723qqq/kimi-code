import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import { join } from 'pathe';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { MCP_SECTION, type McpSection } from '#/app/mcpConfig/configSection';
import { IMcpConfigStore, type McpConfigWriteEvent } from '#/app/mcpConfig/configStore';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import { IPluginService } from '#/app/plugin/plugin';
import type { PluginReloadEvent } from '#/app/plugin/types';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { HostFileSystem } from '#/os/backends/host/hostFsService';
import { HostProcessService } from '#/os/backends/host/hostProcessService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { IProjectContext } from '#/project/projectContext/projectContext';
import { IProjectDirs } from '#/project/projectDirs/projectDirs';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';
import { IProjectTrust } from '#/project/projectTrust/projectTrust';
import { IProjectMcpConfigService } from '#/project/projectMcpConfig/projectMcpConfig';
import { WorkspaceMcpConfigService } from '#/project/projectMcpConfig/projectMcpConfigService';
import { IProjectMcpService } from '#/project/projectMcp/projectMcp';
import { WorkspaceMcpService } from '#/project/projectMcp/projectMcpService';

import { stubLog } from '../../_base/log/stubs';
import { registerAgentIdentityStub } from '../../app/agentIdentity/stubs';
import { createMemoryMcpOAuthStore, slowToolStdioFixture, stdioFixture } from '../../mcpCore/stubs';

describe('Workspace MCP initialization', () => {
  let cwd: string;
  let homeDir: string;
  let disposables: DisposableStore;
  let manager: McpConnectionManager | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'kimi-session-mcp-cwd-'));
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-session-mcp-home-'));
    disposables = new DisposableStore();
    manager = undefined;
  });

  afterEach(async () => {
    await manager?.shutdown();
    disposables.dispose();
    await Promise.all([
      rm(cwd, { recursive: true, force: true }),
      rm(homeDir, { recursive: true, force: true }),
    ]);
  });

  function createWorkspaceMcpService(ready: Promise<void>, mcpSection?: McpSection) {
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.definePartialInstance(IBootstrapService, { homeDir });
        reg.definePartialInstance(IProjectContext, { cwd, workspaceId: 'test-workspace' });
        reg.definePartialInstance(IProjectDirs, {
          ready: Promise.resolve(),
          primary: cwd,
          additionalDirs: [],
          sharedAdditionalDirs: [],
          ISessionProjectInfo: {},
          onDidChange: Event.None as Event<void>,
        });
        reg.definePartialInstance(IPluginService, {
          enabledMcpServers: async () => ({}),
          onDidReload: Event.None as Event<PluginReloadEvent>,
        });
        reg.definePartialInstance(
          IMcpOAuthService,
          new McpOAuthService({ store: createMemoryMcpOAuthStore() }),
        );
        reg.definePartialInstance(IMcpConfigStore, {
          onDidWrite: Event.None as Event<McpConfigWriteEvent>,
        });
        reg.defineInstance(ILogService, stubLog());
        reg.defineInstance(ITelemetryService, noopTelemetryService);
        const environment = Object.assign(
          new FakeEnvironment(
            { environmentId: 'local', generation: 'test-generation' },
            {
              capabilities: ['process'],
              pathClass: process.platform === 'win32' ? 'win32' : 'posix',
            },
          ),
          { process: new HostProcessService() },
        );
        reg.definePartialInstance(IEnvironmentService, { _serviceBrand: undefined, inspect: () => environment, acquire: () => ({ environment, track: (resource) => resource, dispose: () => {} }), acquireWhenReady: async () => ({ environment, track: (resource) => resource, dispose: () => {} }) });
        reg.definePartialInstance(IConfigService, {
          ready,
          onDidSectionChange: Event.None as IConfigService['onDidSectionChange'],
          get: <T = unknown>(domain: string): T =>
            (domain === MCP_SECTION ? mcpSection : undefined) as T,
        });
        reg.defineInstance(IHostFileSystem, new HostFileSystem());
        reg.definePartialInstance(IProjectTrust, {
          ready: Promise.resolve(),
          get: async () => true,
          isTrusted: () => true,
          onDidChange: Event.None as IProjectTrust['onDidChange'],
        });
        reg.define(IProjectMcpConfigService, WorkspaceMcpConfigService);
        registerAgentIdentityStub(reg);
        reg.define(IProjectMcpService, WorkspaceMcpService);
      },
    });
    return ix.get(IProjectMcpService);
  }

  it('exposes the connection manager before config is ready and starts connecting once ready', async () => {
    let resolveConfigReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveConfigReady = resolve;
    });
    await writeProjectMcpJson(cwd, {
      alpha: {
        transport: 'stdio',
        command: process.execPath,
        args: [stdioFixture],
        environment_id: 'local',
      },
    });
    const service = createWorkspaceMcpService(ready);
    manager = service.connectionManager();
    expect(manager.list()).toEqual([]);

    await delay(50);
    expect(manager.list()).toEqual([]);

    resolveConfigReady();
    await service.ready;
    expect(manager.get('alpha')?.status).toBe('connected');
  }, 15000);

  it('times out tool calls using the session MCP timeout preference', async () => {
    await writeProjectMcpJson(cwd, {
      slowTool: {
        transport: 'stdio',
        command: process.execPath,
        args: [slowToolStdioFixture],
        environment_id: 'local',
        env: { KIMI_TEST_MCP_TOOL_DELAY_MS: '300' },
      },
    });
    const service = createWorkspaceMcpService(Promise.resolve(), { toolTimeoutMs: 1 });
    await service.ready;
    manager = service.connectionManager();
    const client = manager.resolved('slowTool')?.client;
    if (client === undefined) throw new Error('expected a connected client');
    await expect(client.callTool('slow_echo', { text: 'hi' })).rejects.toThrow(/timed out/i);
  }, 15000);

  it.skipIf(process.platform === 'win32')(
    'disposeAsync resolves only after the server process has exited',
    async () => {
      const marker = join(cwd, 'mcp-exit-marker');
      await writeProjectMcpJson(cwd, {
        slowExit: {
          transport: 'stdio',
          command: process.execPath,
          args: [stdioFixture],
          runtime_id: 'local',
          env: {
            KIMI_TEST_MCP_SHUTDOWN_BEHAVIOR: 'delay',
            KIMI_TEST_MCP_EXIT_DELAY_MS: '300',
            KIMI_TEST_MCP_EXIT_MARKER: marker,
          },
        },
      });
      const service = createWorkspaceMcpService(Promise.resolve());
      await service.ready;
      const connectionManager = service.connectionManager();
      manager = undefined;
      expect(connectionManager.get('slowExit')?.status).toBe('connected');

      await (service as unknown as { disposeAsync(): Promise<void> }).disposeAsync();

      expect(existsSync(marker)).toBe(true);
    },
    15000,
  );
});

async function writeProjectMcpJson(cwd: string, servers: Record<string, unknown>): Promise<void> {
  await mkdir(join(cwd, '.kimi-code'), { recursive: true });
  await writeFile(
    join(cwd, '.kimi-code', 'mcp.json'),
    JSON.stringify({ mcpServers: servers }),
    'utf8',
  );
}
