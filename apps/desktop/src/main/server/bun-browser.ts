import type { DesktopBrowserAgentControl } from '../../backend/browser-mcp';
import type { BackendChannel } from '../../shared/backend-channel';
import {
  BackendRequestError,
  type BackendEventPayload,
  type BackendInput,
  type BackendOutput,
} from '../../shared/backend-protocol';
import type { BrowserSubagentRun } from '../../shared/browser-run';
import { sameBrowserSubagentRun } from '../../shared/browser-run';

export interface BunBrowserHost {
  execute(
    input: BackendInput<'browser.run'>,
    signal: AbortSignal,
    assertActive: () => void,
    validateActive: () => Promise<void>,
  ): Promise<BackendOutput<'browser.run'>>;
  collect(sessionId: string): Promise<BackendOutput<'browser.collect-dialogs'>>;
  forget(sessionId: string): void;
  revoke(sessionId: string, run: BrowserSubagentRun, settingChange: boolean): void;
  restore(): void;
  operation(payload: BackendEventPayload<'telemetry.browser-operation'>): void;
  reconnect(payload: BackendEventPayload<'telemetry.browser-reconnect'>): void;
}

export class BunBrowserBridge {
  private revision = 0;
  private ready = false;
  private closed = false;
  private readonly active = new Set<{
    sessionId?: string;
    run?: BrowserSubagentRun;
    abort: AbortController;
  }>();
  private readonly disposables: Array<() => void>;

  constructor(
    private readonly channel: BackendChannel,
    private readonly agent: DesktopBrowserAgentControl,
    private readonly subagent: DesktopBrowserAgentControl,
    private readonly host: BunBrowserHost,
  ) {
    channel.handle('browser.run', async (input, signal) => {
      const operation = {
        sessionId: input.sessionId,
        run: input.owner ?? input.controller?.run,
        abort: new AbortController(),
      };
      const assertActive = (): void => {
        if (
          this.closed ||
          !this.ready ||
          !channel.connected ||
          operation.abort.signal.aborted ||
          signal.aborted ||
          input.settingsRevision !== this.revision
        ) {
          throw new BackendRequestError(
            'cancelled',
            'Desktop browser authorization is no longer current',
          );
        }
        if (input.controller !== undefined && (!agent.enabled() || !subagent.enabled()))
          throw new BackendRequestError(
            'not_ready',
            'Desktop subagent browser control is disabled',
          );
      };
      assertActive();
      this.active.add(operation);
      try {
        const validateActive = async (): Promise<void> => {
          assertActive();
          if (
            input.owner !== undefined &&
            input.sessionId !== undefined &&
            !(await channel.request(
              'browser.validate-owner',
              {
                sessionId: input.sessionId,
                owner: input.owner,
                settingsRevision: input.settingsRevision,
              },
              { signal: operation.abort.signal },
            ))
          ) {
            operation.abort.abort();
            throw new BackendRequestError('not_ready', 'Desktop browser owner is no longer active');
          }
          assertActive();
        };
        await validateActive();
        const result = await host.execute(
          input,
          AbortSignal.any([signal, operation.abort.signal]),
          assertActive,
          validateActive,
        );
        assertActive();
        return result;
      } finally {
        this.active.delete(operation);
      }
    });
    channel.handle('browser.collect-dialogs', ({ sessionId }) => {
      if (this.closed || !channel.connected) return null;
      return host.collect(sessionId);
    });
    channel.on('browser.forget-dialogs', ({ sessionId }) => host.forget(sessionId));
    channel.on('browser.revoke-run', ({ sessionId, run, settingChange }) => {
      for (const operation of this.active) {
        if (
          operation.sessionId === sessionId &&
          operation.run !== undefined &&
          sameBrowserSubagentRun(operation.run, run)
        )
          operation.abort.abort();
      }
      host.revoke(sessionId, run, settingChange);
    });
    channel.on('browser.restore-runs', ({ settingsRevision }) => {
      if (
        !this.closed &&
        settingsRevision === this.revision &&
        agent.enabled() &&
        subagent.enabled()
      )
        host.restore();
    });
    channel.on('telemetry.browser-operation', (payload) => host.operation(payload));
    channel.on('telemetry.browser-reconnect', (payload) => host.reconnect(payload));
    this.disposables = [
      agent.onDidChange(() => this.settingsChanged()),
      subagent.onDidChange(() => this.settingsChanged()),
      channel.onDisconnect(() => this.dispose()),
    ];
  }

  get settings(): BackendInput<'start'>['browser'] {
    return {
      revision: this.revision,
      agent: this.agent.enabled(),
      subagent: this.subagent.enabled(),
    };
  }

  activate(): void {
    if (this.closed) throw new Error('Desktop browser bridge is closed');
    this.ready = true;
    if (this.revision !== 0)
      void this.channel.emit('browser.settings', this.settings).catch(() => this.dispose());
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    for (const operation of this.active) {
      operation.abort.abort();
      if (operation.sessionId !== undefined && operation.run !== undefined)
        this.host.revoke(operation.sessionId, operation.run, false);
    }
    this.active.clear();
    for (const dispose of this.disposables ?? []) dispose();
  }

  private settingsChanged(): void {
    ++this.revision;
    for (const operation of this.active) {
      operation.abort.abort();
      if (operation.sessionId !== undefined && operation.run !== undefined)
        this.host.revoke(operation.sessionId, operation.run, true);
    }
    if (this.ready && !this.closed)
      void this.channel.emit('browser.settings', this.settings).catch(() => this.dispose());
  }
}
