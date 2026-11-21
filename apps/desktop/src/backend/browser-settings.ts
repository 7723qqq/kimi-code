import type { BackendEventPayload } from '../shared/backend-protocol';
import type { DesktopBrowserAgentControl } from './browser-mcp';

export class BackendBrowserSettings {
  private current: BackendEventPayload<'browser.settings'>;
  private readonly agentListeners = new Set<(enabled: boolean) => void>();
  private readonly subagentListeners = new Set<(enabled: boolean) => void>();

  constructor(initial: BackendEventPayload<'browser.settings'>) {
    this.current = initial;
  }

  get revision(): number {
    return this.current.revision;
  }

  readonly agent: DesktopBrowserAgentControl = {
    enabled: () => this.current.agent,
    onDidChange: (listener) => {
      this.agentListeners.add(listener);
      return () => {
        this.agentListeners.delete(listener);
      };
    },
  };

  readonly subagent: DesktopBrowserAgentControl = {
    enabled: () => this.current.subagent,
    onDidChange: (listener) => {
      this.subagentListeners.add(listener);
      return () => {
        this.subagentListeners.delete(listener);
      };
    },
  };

  update(next: BackendEventPayload<'browser.settings'>): void {
    if (next.revision <= this.current.revision)
      throw new Error('Desktop browser settings revision did not advance');
    const previous = this.current;
    this.current = next;
    if (previous.agent !== next.agent)
      for (const listener of this.agentListeners) listener(next.agent);
    if (previous.subagent !== next.subagent)
      for (const listener of this.subagentListeners) listener(next.subagent);
  }
}
