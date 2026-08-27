import {
  ensureMainAgent as ensureMainAgentContext,
  IAgentLifecycleService,
  MAIN_AGENT_ID,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
} from '@moonshot-ai/agent-core-v2';

import { t } from '../i18n';

export { MAIN_AGENT_ID };

export async function ensureMainAgent(session: ISessionScopeHandle): Promise<IAgentScopeHandle> {
  const context = await ensureMainAgentContext(session);
  const handle = session.accessor.get(IAgentLifecycleService).handleOf(context.agentId);
  if (handle === undefined) {
    throw new Error(t('v2Errors.mainAgentNotFound'));
  }
  return handle;
}
