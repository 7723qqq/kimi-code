import type { ServiceRegistration } from '#/_base/di/test';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAppStateService } from '#/app/state/appState';
import { AppStateService } from '#/app/state/appStateService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { WorkspaceStateService } from '#/workspace/state/workspaceStateService';

export function registerStateServices(reg: ServiceRegistration): void {
  const app = new AppStateService();
  const workspace = new WorkspaceStateService(app);
  const session = new SessionStateService();
  const agent = new AgentStateService(session);
  reg.defineInstance(IAppStateService, app);
  reg.defineInstance(IWorkspaceStateService, workspace);
  reg.defineInstance(ISessionStateService, session);
  reg.defineInstance(IAgentStateService, agent);
}
