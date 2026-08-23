import type { IPty } from 'node-pty';

import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';

import { IHostTerminalService, type TerminalProcess, type TerminalSpawnOptions } from '#/os/interface/terminal';

interface BunTerminal {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface BunSubprocessWithTerminal {
  readonly terminal: BunTerminal;
  readonly exited: Promise<number | null>;
  kill(): void;
}

interface BunGlobalLike {
  spawn(
    command: readonly string[],
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      terminal: {
        name?: string;
        cols?: number;
        rows?: number;
        data(terminal: BunTerminal, data: Uint8Array): void;
      };
    },
  ): BunSubprocessWithTerminal;
}

function currentBun(): BunGlobalLike | undefined {
  return (globalThis as unknown as { Bun?: BunGlobalLike }).Bun;
}

export class HostTerminalService extends Service implements IHostTerminalService {
  declare readonly _serviceBrand: undefined;

  private readonly processes = new Set<TerminalProcess>();

  spawn(options: TerminalSpawnOptions): Promise<TerminalProcess> {
    const bun = currentBun();
    if (bun !== undefined) return Promise.resolve(this.spawnBun(bun, options));
    return this.spawnNodePty(options);
  }

  private spawnBun(bun: BunGlobalLike, options: TerminalSpawnOptions): TerminalProcess {
    const dataEmitter = new Emitter<string>('hostTerminal.data');
    const exitEmitter = new Emitter<{ exitCode: number | null }>('hostTerminal.exit');
    const decoder = new TextDecoder();
    const proc = bun.spawn([options.shell], {
      cwd: options.cwd,
      env: { ...process.env },
      terminal: {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        data: (_terminal, data) => dataEmitter.fire(decoder.decode(data)),
      },
    });
    void proc.exited.then((exitCode) => {
      exitEmitter.fire({ exitCode });
      dataEmitter.dispose();
      exitEmitter.dispose();
      return undefined;
    });
    const terminalProcess: TerminalProcess = {
      onProcessData: dataEmitter.event,
      onProcessExit: exitEmitter.event,
      write: (data) => proc.terminal.write(data),
      resize: (cols, rows) => proc.terminal.resize(cols, rows),
      kill: () => {
        try {
          proc.kill();
        } catch {
          proc.terminal.close();
          return;
        }
        proc.terminal.close();
      },
    };
    this.processes.add(terminalProcess);
    return terminalProcess;
  }

  private async spawnNodePty(options: TerminalSpawnOptions): Promise<TerminalProcess> {
    const pty = await import('node-pty');
    const proc: IPty = pty.spawn(options.shell, [], {
      name: 'xterm-256color',
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      env: globalThis.process.env,
    });
    const terminalProcess: TerminalProcess = {
      onProcessData: (listener) => proc.onData(listener),
      onProcessExit: (listener) => proc.onExit((event) => listener({ exitCode: event.exitCode })),
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: () => proc.kill(),
    };
    this.processes.add(terminalProcess);
    return terminalProcess;
  }

  override dispose(): void {
    for (const process of this.processes) {
      try {
        process.kill();
      } catch {
      }
    }
    this.processes.clear();
    super.dispose();
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostTerminalService,
  HostTerminalService,
  ScopeActivation.OnScopeCreated,
  'terminal',
);
