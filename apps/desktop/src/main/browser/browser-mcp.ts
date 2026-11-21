import { startDesktopBrowserMcp as start, type DesktopBrowserAccess } from '../../backend/browser-mcp';
import { asBrowserRunRequest, describeInvalidBrowserRunRequest } from '../../shared/browser-automation';
import { BrowserControlError } from '../../shared/browser-control-error';
import { trySendDesktopEvent } from '../diagnostics/track';
import { isAgentLocalFileAddress, runBrowserAutomation } from './browser-automation';
import { formatBrowserToolResult } from './browser-tool-output';

export * from '../../backend/browser-mcp';

export function startDesktopBrowserMcp(options: { token?: string; access?: DesktopBrowserAccess } = {}) {
  return start({
    ...options,
    track: (event) => trySendDesktopEvent('browser_operation_result', event),
    execute: async ({ args, sessionId, controller }, signal) => {
      const input = asBrowserRunRequest(args, { isLocalFileAddress: isAgentLocalFileAddress });
      if (input === null) return { operation: 'unknown', errorCode: 'INVALID_ARGS', text: describeInvalidBrowserRunRequest(args, { isLocalFileAddress: isAgentLocalFileAddress }) };
      const run = controller === undefined ? undefined : {
        ...controller,
        assertActive() {
          if (options.access?.resolveRun?.(sessionId, controller.run) === undefined) throw new BrowserControlError('BROWSER_SUBAGENT_UNAVAILABLE', 'Browser run is no longer active');
        },
      };
      const result = await runBrowserAutomation(input, signal, sessionId, run);
      const image = result.visual ?? result.crop;
      return { operation: result.operation, errorCode: result.ok ? undefined : result.error?.code ?? 'INTERNAL_ERROR', text: formatBrowserToolResult(result), image };
    },
  });
}
