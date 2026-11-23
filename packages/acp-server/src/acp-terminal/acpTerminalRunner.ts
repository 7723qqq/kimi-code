import { PassThrough, Writable, type Readable } from 'node:stream';

import {
  IAgentEnvironmentOverlay,
  LOCAL_ENVIRONMENT_ID,
  LifecycleScope,
  ScopeActivation,
  overrideScopedService,
  type EnvironmentLease,
  type HostProcessOptions,
  type IHostProcess,
  type IHostProcessService,
  ISessionContext,
} from '@moonshot-ai/agent-core-v2';

import { AcpHostFileSystem, IAcpConnection, type IAcpTerminalHandle } from '../acp-fs';

const OUTPUT_BYTE_LIMIT = 4 * 1024 * 1024;
const OUTPUT_POLL_MS = 250;

export interface AcpTerminalTimerHandle {
  unref?(): void;
}

export interface AcpTerminalTimers {
  setInterval(callback: () => void, intervalMs: number): AcpTerminalTimerHandle;
  clearInterval(handle: AcpTerminalTimerHandle): void;
}

export const ACP_TERMINAL_TIMERS: AcpTerminalTimers = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

const TRUNCATION_NOTICE =
  '\n[terminal] output truncated at 4 MiB; earlier bytes are not recoverable\n';

function isBashToolInvocation(args: readonly string[], options?: HostProcessOptions): boolean {
  return (
    args.length === 2 &&
    args[0] === '-c' &&
    options?.env?.['NO_COLOR'] === '1' &&
    options?.env?.['TERM'] === 'dumb'
  );
}

function envRecordToAcp(
  env: Record<string, string> | undefined,
): Array<{ name: string; value: string }> | undefined {
  if (env === undefined) return undefined;
  return Object.entries(env).map(([name, value]) => ({ name, value }));
}

class AcpProcessService implements IHostProcessService {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
    private readonly connection: IAcpConnection,
    private readonly local: IHostProcessService,
    private readonly timers: AcpTerminalTimers = ACP_TERMINAL_TIMERS,
  ) {}

  async spawn(
    command: string,
    args: readonly string[] = [],
    options?: HostProcessOptions,
  ): Promise<IHostProcess> {
    if (!isBashToolInvocation(args, options)) {
      return this.local.spawn(command, args, options);
    }

    const handle = await this.connection.get().createTerminal({
      sessionId: this.sessionId,
      command,
      args: [...args],
      env: envRecordToAcp(options?.env),
      cwd: options?.cwd ?? this.cwd,
      outputByteLimit: OUTPUT_BYTE_LIMIT,
    });
    this.connection.notifyTerminalCreated({
      sessionId: this.sessionId,
      shellCommand: args[1] ?? '',
      terminalId: handle.id,
    });
    return new AcpTerminalProcess(handle, this.timers);
  }
}

class AcpTerminalProcess implements IHostProcess {
  declare readonly _serviceBrand: undefined;
  readonly stdin: Writable;
  readonly stdout: PassThrough;
  readonly stderr: Readable;
  readonly pid = 0;

  private _exitCode: number | null = null;
  private emitted = 0;
  private truncatedNotified = false;
  private readonly pollTimer: AcpTerminalTimerHandle;
  private readonly waitPromise: Promise<number>;
  private released = false;

  constructor(
    private readonly handle: IAcpTerminalHandle,
    private readonly timers: AcpTerminalTimers = ACP_TERMINAL_TIMERS,
  ) {
    this.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    this.stdout = new PassThrough();
    const stderr = new PassThrough();
    stderr.end();
    this.stderr = stderr;
    const waitPromise = this.run();
    waitPromise.catch(() => {});
    this.waitPromise = waitPromise;
    this.pollTimer = this.timers.setInterval(() => {
      void this.pump();
    }, OUTPUT_POLL_MS);
    this.pollTimer.unref?.();
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  wait(): Promise<number> {
    return this.waitPromise;
  }

  async kill(_signal?: NodeJS.Signals): Promise<void> {
    await this.handle.kill();
  }

  async dispose(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.stopPolling();
    try {
      await this.handle.release();
    } catch {
    }
  }

  private async run(): Promise<number> {
    const status = await this.handle.waitForExit();
    this._exitCode = status.exitCode ?? -1;
    await this.pump();
    this.stopPolling();
    this.stdout.end();
    return this._exitCode;
  }

  private async pump(): Promise<void> {
    try {
      const { output, truncated } = await this.handle.currentOutput();
      if (truncated === true) {
        this.notifyTruncated();
        this.emitted = output.length;
        return;
      }
      if (output.length > this.emitted) {
        this.stdout.write(output.slice(this.emitted));
        this.emitted = output.length;
        return;
      }
      if (output.length < this.emitted) {
        this.notifyTruncated();
        this.emitted = output.length;
      }
    } catch {
    }
  }

  private notifyTruncated(): void {
    if (this.truncatedNotified) return;
    this.truncatedNotified = true;
    this.stdout.write(TRUNCATION_NOTICE);
  }

  private stopPolling(): void {
    this.timers.clearInterval(this.pollTimer);
  }
}

export class AcpEnvironmentOverlay implements IAgentEnvironmentOverlay {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionContext private readonly session: ISessionContext,
    @IAcpConnection private readonly connection: IAcpConnection,
    private readonly timers: AcpTerminalTimers = ACP_TERMINAL_TIMERS,
  ) {}

  decorate(lease: EnvironmentLease): EnvironmentLease {
    if (lease.environment.identity.environmentId !== LOCAL_ENVIRONMENT_ID) return lease;
    const process = this.connection.terminalEnabled
      ? new AcpProcessService(
          this.session.sessionId,
          this.session.cwd,
          this.connection,
          lease.environment.process!,
          this.timers,
        )
      : lease.environment.process;
    const fs = new AcpHostFileSystem(this.session, this.connection);
    const environment = new Proxy(lease.environment, {
      get: (target, property) => {
        if (property === 'fs') return fs;
        if (property === 'process') return process;
        return Reflect.get(target, property, target);
      },
    });
    return { ...lease, environment };
  }
}

overrideScopedService(
  LifecycleScope.Session,
  IAgentEnvironmentOverlay,
  AcpEnvironmentOverlay,
  ScopeActivation.OnDemand,
  'acp',
);
