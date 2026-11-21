export class BrowserControlError extends Error {
  constructor(
    readonly code:
      | 'BROWSER_USER_TAKEOVER'
      | 'BROWSER_SUBAGENT_UNAVAILABLE'
      | 'PAGE_NOT_READY'
      | 'TAB_NOT_ACTIVE',
    message: string,
  ) {
    super(message);
  }
}
