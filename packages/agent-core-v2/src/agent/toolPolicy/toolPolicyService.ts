import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentProfileService, ProfileError, ProfileErrors } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { LifecycleScope } from '#/app/scopes';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { isMcpToolName, type ToolSource } from '#/tool/toolContract';

import { TOOLS_SECTION, type ToolsConfig } from './configSection';
import { isToolActive, isToolActiveComposed, type ToolActivationPolicy } from './evaluate';
import { IAgentToolPolicyService } from './toolPolicy';

export class AgentToolPolicyService extends Disposable implements IAgentToolPolicyService {
  declare readonly _serviceBrand: undefined;
  private globalPolicy: ToolsConfig | undefined;
  private turnPolicy:
    | { readonly activeToolNames: readonly string[] | undefined; readonly disallowedTools: readonly string[] | undefined }
    | undefined;

  constructor(
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IConfigService private readonly config: IConfigService,
    @ISessionToolPolicy private readonly sessionToolPolicy: ISessionToolPolicy,
    @ISessionToolPolicyGate private readonly toolPolicyGate: ISessionToolPolicyGate,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IEventBus eventBus: IEventBus,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    super();
    this.globalPolicy = this.config.get<ToolsConfig | undefined>(TOOLS_SECTION);
    this._register(eventBus.subscribe(TurnStarted, (event) => {
      if (event.agentId !== scopeContext.agentId) return;
      const data = this.profile.data();
      this.turnPolicy = {
        activeToolNames: data.activeToolNames,
        disallowedTools: data.disallowedTools,
      };
    }));
    this._register(eventBus.subscribe(TurnEnded, (event) => {
      if (event.agentId !== scopeContext.agentId) return;
      this.turnPolicy = undefined;
    }));
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain !== TOOLS_SECTION) return;
        this.globalPolicy = this.config.get<ToolsConfig | undefined>(TOOLS_SECTION);
      }),
    );
    this._register(
      toolExecutor.registerToolCallGuard(({ name, source }) => {
        const active =
          name === SELECT_TOOLS_TOOL_NAME
            ? this.isToolActiveForDisclosure(name, source)
            : this.isToolActive(name, source);
        return active ? undefined : `Tool "${name}" is disabled by the active tool policy`;
      }),
    );
  }

  isToolActive(name: string, source: ToolSource = 'builtin'): boolean {
    const policy = this.activePolicy();
    return this.isToolActiveForProfile(
      {
        tools: policy.activeToolNames,
        disallowedTools: policy.disallowedTools,
      },
      name,
      source,
    );
  }

  isToolDenied(
    name: string,
    source: ToolSource = isMcpToolName(name) ? 'mcp' : 'builtin',
  ): boolean {
    const deniedBy = (list: readonly string[] | undefined): boolean =>
      list !== undefined && !isToolActive({ disallowedTools: list }, name, source);
    return (
      deniedBy(this.toolPolicyGate.disabledTools) ||
      deniedBy(this.profile.data().disallowedTools) ||
      deniedBy(this.globalPolicy?.disabled) ||
      deniedBy(this.sessionToolPolicy.disabledTools())
    );
  }

  getPolicyFingerprint(): string {
    const policy = this.activePolicy();
    return JSON.stringify(
      [
        this.toolPolicyGate.disabledTools,
        policy.activeToolNames,
        policy.disallowedTools,
        this.globalPolicy?.enabled,
        this.globalPolicy?.disabled,
        this.sessionToolPolicy.disabledTools(),
      ].map((names) => (names === undefined ? null : [...new Set(names)].toSorted())),
    );
  }

  isToolActiveForDisclosure(name: string, source: ToolSource = 'builtin'): boolean {
    const policy = this.activePolicy();
    return isToolActiveComposed(
      {
        workspaceDisabledTools: this.toolPolicyGate.disabledTools,
        profile: { disallowedTools: policy.disallowedTools },
        global: this.globalPolicy,
        sessionDisabledTools: this.sessionToolPolicy.disabledTools(),
      },
      name,
      source,
    );
  }

  isToolActiveForProfile(
    profile: ToolActivationPolicy,
    name: string,
    source: ToolSource = 'builtin',
  ): boolean {
    return isToolActiveComposed(
      {
        workspaceDisabledTools: this.toolPolicyGate.disabledTools,
        profile,
        global: this.globalPolicy,
        sessionDisabledTools: this.sessionToolPolicy.disabledTools(),
      },
      name,
      source,
    );
  }

  private activePolicy(): { readonly activeToolNames: readonly string[] | undefined; readonly disallowedTools: readonly string[] | undefined } {
    if (this.turnPolicy !== undefined) return this.turnPolicy;
    const data = this.profile.data();
    return { activeToolNames: data.activeToolNames, disallowedTools: data.disallowedTools };
  }

  async setSessionDisabledTools(names: readonly string[]): Promise<void> {
    if (this.profile.data().profileName === undefined) {
      throw new ProfileError(
        ProfileErrors.codes.PROFILE_NOT_BOUND,
        'Cannot set session disabled tools: agent profile is not bound',
      );
    }
    await this.sessionToolPolicy.setDisabledTools(names);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolPolicyService,
  AgentToolPolicyService,
  ScopeActivation.OnScopeCreated,
  'toolPolicy',
);
