import { Emitter } from '#/_base/event';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import {
  IHostTerminalService,
  type HostTerminalBunRuntime,
  type TerminalProcess,
  type TerminalSpawnOptions,
} from '#/os/interface/terminal';

export class HostTerminalService extends Service implements IHostTerminalService {
  declare readonly _serviceBrand: undefined;

  private readonly processes = new Set<TerminalProcess>();

  spawn(
    options: TerminalSpawnOptions,
    bunOverride?: HostTerminalBunRuntime,
  ): Promise<TerminalProcess> {
    return Promise.resolve(this.spawnBun(options, bunOverride));
  }

  private spawnBun(
    options: TerminalSpawnOptions,
    bunOverride: HostTerminalBunRuntime | undefined,
  ): TerminalProcess {
    const bun = bunOverride ?? (globalThis as unknown as { Bun?: HostTerminalBunRuntime }).Bun;
    if (bun === undefined) {
      throw new Error(
        'HostTerminalService requires Bun runtime (globalThis.Bun.Terminal is unavailable).',
      );
    }
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
        data: (_terminal, data) => {
          const text = decoder.decode(data, { stream: true });
          if (text.length > 0) dataEmitter.fire(text);
        },
      },
    });
    void proc.exited.then((exitCode) => {
      const rest = decoder.decode();
      if (rest.length > 0) dataEmitter.fire(rest);
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
