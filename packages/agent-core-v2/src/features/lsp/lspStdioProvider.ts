import { normalize } from 'pathe';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { IConfigService } from '#/app/config/config';
import {
  ILspService,
  type LspProvider,
  type LspProviderQuery,
  type LspQueryResult,
} from '#/features/lsp/lsp';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionProcessRunner } from '#/session/process/processRunner';

import { LSP_SECTION, type LspConfig, type LspServerConfig } from './configSection';
import { LspTransportClosedError } from './lspConnection';
import { LspInstance } from './lspInstance';

export class LspStdioProvider implements LspProvider {
  private readonly instances = new Map<string, LspInstance>();
  private disposed = false;

  constructor(
    readonly id: string,
    private readonly config: LspServerConfig,
    private readonly processRunner: ISessionProcessRunner,
    private readonly hostFs: IHostFileSystem,
  ) {}

  get extensionToLanguage(): Readonly<Record<string, string>> {
    return this.config.extensionToLanguage;
  }

  async query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult> {
    if (this.disposed) {
      throw new Error(`LSP provider "${this.id}" is disposed`);
    }
    const key = normalizeWorkspaceKey(request.workspaceRoot);
    let instance = this.instances.get(key);
    if (instance === undefined || instance.isClosed) {
      instance = await this.createInstance(key);
      this.instances.set(key, instance);
    }
    let retried = false;
    try {
      return await instance.query(request, signal);
    } catch (error) {
      if (isRecoverableTransportError(error) && !retried) {
        retried = true;
        try {
          await instance.dispose();
        } catch {}
        this.instances.delete(key);
        const fresh = await this.createInstance(key);
        this.instances.set(key, fresh);
        return fresh.query(request, signal);
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const instances = [...this.instances.values()];
    this.instances.clear();
    await Promise.all(instances.map((instance) => instance.dispose()));
  }

  private async createInstance(workspaceRoot: string): Promise<LspInstance> {
    return LspInstance.create(this.config, this.processRunner, this.hostFs, workspaceRoot);
  }
}

export class LspStdioProviderService extends Service {
  constructor(
    @IConfigService config: IConfigService,
    @ILspService lsp: ILspService,
    @ISessionProcessRunner processRunner: ISessionProcessRunner,
    @IHostFileSystem hostFs: IHostFileSystem,
  ) {
    super();
    const servers = config.get<LspConfig | undefined>(LSP_SECTION)?.servers;
    if (servers === undefined) return;
    for (const [id, serverConfig] of Object.entries(servers)) {
      const provider = new LspStdioProvider(id, serverConfig, processRunner, hostFs);
      this._register(lsp.registerProvider(provider));
      this._register(
        toDisposable(() => {
          void provider.dispose();
        }),
      );
    }
  }
}

export const ILspStdioProviderService: ServiceIdentifier<LspStdioProviderService> =
  createDecorator<LspStdioProviderService>('lspStdioProviderService');

function normalizeWorkspaceKey(workspaceRoot: string): string {
  return normalize(workspaceRoot);
}

function isRecoverableTransportError(error: unknown): boolean {
  return error instanceof LspTransportClosedError;
}
