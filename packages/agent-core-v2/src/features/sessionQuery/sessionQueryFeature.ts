/**
 * `sessionQuery` domain — `SessionQueryFeature`: the logical-corpus query
 * capability assembled as one App-scope Feature unit.
 *
 * Contributes the App-scope `ISessionQueryService` and the Agent-scope
 * `session_query` tool through the `features` base-class seams; retracting the
 * unit withdraws both. The tool is bound to the main agent only ('main'), so
 * subagents cannot query the caller's cross-session corpus behind the caller's
 * back. Registered into the feature table at import.
 */

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
