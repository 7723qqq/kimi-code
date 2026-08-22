import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { ISessionQueryService, SessionQueryService } from './sessionQueryService';
import { SessionQueryTool } from './sessionQueryTool';
import { ISessionQueryTool } from './toolContract';

export class SessionQueryFeature extends Feature {
  static override readonly name = 'sessionQuery';

  constructor() {
    super();
    this.contributeService(LifecycleScope.App, ISessionQueryService, SessionQueryService);
    this.contributeTool(ISessionQueryTool, SessionQueryTool, {
      name: 'session_query',
      domain: 'sessionQuery',
      when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
    });
  }
}

registerFeature(SessionQueryFeature);
