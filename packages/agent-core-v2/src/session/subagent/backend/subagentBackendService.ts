import { t } from '@moonshot-ai/kimi-i18n';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import '#/session/process/processRunnerService';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { resolveSandboxPolicy } from '#/workspace/sandbox/sandbox';

import { AcpBackend } from './acpBackend';
import { ClaudeCodeBackend } from './claudeCodeBackend';
import { CodexBackend } from './codexBackend';
import {
  ISubagentBackendService,
  SUBAGENT_BACKEND_NAMES,
  type ISubagentBackend,
  type SubagentBackendName,
  type SubagentBackendRun,
  type SubagentBackendStartRequest,
} from './subagentBackend';

export class SubagentBackendService extends Service implements ISubagentBackendService {
  declare readonly _serviceBrand: undefined;

  private readonly backends = new Map<SubagentBackendName, ISubagentBackend>();

  constructor(
    @ISessionProcessRunner processRunner: ISessionProcessRunner,
    @IConfigService private readonly configService: IConfigService,
  ) {
    super();
    this.register(new ClaudeCodeBackend(configService));
    this.register(new CodexBackend(processRunner, configService));
    this.register(new AcpBackend(processRunner, configService));
  }

  getBackend(name: SubagentBackendName): ISubagentBackend | undefined {
    return this.backends.get(name);
  }

  list(): readonly ISubagentBackend[] {
    return [...this.backends.values()];
  }

  async start(
    name: SubagentBackendName,
    request: SubagentBackendStartRequest,
  ): Promise<SubagentBackendRun> {
    const backend = this.backends.get(name);
    if (backend === undefined) {
      throw new Error(
        `Unknown subagent backend "${name}". Available backends: ${SUBAGENT_BACKEND_NAMES.join(', ')}.`,
      );
    }
    const policy = resolveSandboxPolicy(this.configService, request.cwd);
    if (policy.mode !== 'off') {
      throw new Error(
        t('toolsV2.sandbox.externalSubagentBackendBlocked', { mode: policy.mode, backend: name }),
      );
    }
    return backend.start(request);
  }

  private register(backend: ISubagentBackend): void {
    this.backends.set(backend.name, backend);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISubagentBackendService,
  SubagentBackendService,
  ScopeActivation.OnScopeCreated,
  'subagent',
);
