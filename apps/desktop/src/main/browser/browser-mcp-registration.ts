import type { Scope } from '@moonshot-ai/agent-core-v2';

import { registerDesktopBrowserMcp as register, type DesktopBrowserSessionAccess } from '../../backend/browser-mcp-registration';
import type { DesktopBrowserMcpHandle } from '../../backend/browser-mcp';
import { trySendDesktopEvent } from '../diagnostics/track';
import { restoreBrowserSubagentRuns, revokeBrowserSubagentRun } from './browser-control';

export * from '../../backend/browser-mcp-registration';

export function registerDesktopBrowserMcp(core: Scope, config: DesktopBrowserMcpHandle['config'], access: DesktopBrowserSessionAccess) {
  return register(core, config, access, {
    restoreRuns: restoreBrowserSubagentRuns,
    revokeRun: (sessionId, run, settingChange) => revokeBrowserSubagentRun(sessionId, run, settingChange ? 'ipc' : undefined),
    reconnect: (event) => trySendDesktopEvent('browser_mcp_reconnect', event),
  });
}
