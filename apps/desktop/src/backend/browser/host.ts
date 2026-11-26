import type { BrowserRunRequest, BrowserRunResult } from '../../shared/browser-automation';
import type { BrowserDialogRecord, BrowserPendingDialog } from '../../shared/browser-dialogs';
import type { BrowserSubagentRun } from '../../shared/browser-run';

export interface BrowserDialogReminder {
  tabs: { tabId: string; title: string; url: string }[];
  pendingDialogs: BrowserPendingDialog[];
  handledDialogs: (BrowserDialogRecord & { tabId: string })[];
  more: boolean;
}

export interface DesktopBrowserHostState {
  agentControl: boolean;
  subagentControl: boolean;
  localFiles: boolean;
}

export interface DesktopBrowserHost {
  readonly url: string;
  readonly token: string;
  state(): Promise<DesktopBrowserHostState>;
  localFilesEnabled(): boolean;
  run(input: BrowserRunRequest, signal: AbortSignal | undefined, sessionId: string | undefined, run: BrowserSubagentRun | undefined): Promise<BrowserRunResult>;
  collectDialogs(sessionId: string): Promise<BrowserDialogReminder | undefined>;
  forgetSession(sessionId: string): void;
  restoreSubagentRuns(): void;
  revokeSubagentRun(sessionId: string, run: BrowserSubagentRun): void;
  track(event: string, properties?: Record<string, unknown>): void;
}

export type BrowserControlErrorCode =
  | 'BROWSER_USER_TAKEOVER'
  | 'BROWSER_SUBAGENT_UNAVAILABLE'
  | 'PAGE_NOT_READY'
  | 'TAB_NOT_ACTIVE';

export class BrowserControlError extends Error {
  constructor(readonly code: BrowserControlErrorCode, message: string) {
    super(message);
  }
}
