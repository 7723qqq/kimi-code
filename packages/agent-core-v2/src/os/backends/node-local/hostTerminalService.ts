import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { IPty } from 'node-pty';

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

function usableBunTerminal(
  bun: HostTerminalBunRuntime | undefined | null,
): HostTerminalBunRuntime | undefined {
  return bun !== null && bun !== undefined && typeof bun.Terminal === 'function' ? bun : undefined;
}

interface PackagedRootsGlobal {
  /** Injected by the packaged app (SEA/Bun single-file builds); absent in dev. */
  __kimi_getNativePackageRoot?: (packageName: string) => string | null;
}

let ptyModulePromise: Promise<typeof import('node-pty')> | undefined;

/**
 * Load node-pty, preferring the copy extracted into the packaged-build asset
 * cache: a bundled copy resolves its bindings relative to the bundle file,
 * which exists at neither runtime layout. The global is injected by the
 * packaging layer; dev and npm installs leave it unset and fall through to
 * the real module.
 */
async function loadNodePty(): Promise<typeof import('node-pty')> {
  ptyModulePromise ??= (async () => {
    const root = (globalThis as PackagedRootsGlobal).__kimi_getNativePackageRoot?.('node-pty');
    if (root !== null && root !== undefined) {
      try {
        // Load via the package entry file, not the bare name: requiring
        // 'node-pty' from its own package.json relies on self-reference
        // resolution, which Bun does not implement.
        const pkg = JSON.parse(
          readFileSync(join(root, 'package.json'), 'utf-8'),
        ) as { main?: string };
        const entry = typeof pkg.main === 'string' && pkg.main.length > 0 ? pkg.main : 'index.js';
        const nativeRequire = createRequire(join(root, 'package.json'));
        return nativeRequire(`./${entry}`) as typeof import('node-pty');
      } catch {
        // Cache copy unusable — fall through to the ambient import.
      }
    }
    return import('node-pty');
  })();
  return ptyModulePromise;
}

export class HostTerminalService extends Service implements IHostTerminalService {
  declare readonly _serviceBrand: undefined;

  private readonly processes = new Set<TerminalProcess>();

  /**
   * Spawn an interactive terminal process.
   *
   * @param bunOverride Backend selection seam for tests and embedders: a
   * Bun-like object routes through Bun.Terminal when it carries one, `null`
   * forces node-pty regardless of host runtime, and omission auto-detects
   * from `globalThis.Bun`.
   */
  spawn(
    options: TerminalSpawnOptions,
    bunOverride?: HostTerminalBunRuntime | null,
  ): Promise<TerminalProcess> {
    const candidate = bunOverride === undefined
      ? (globalThis as unknown as { Bun?: HostTerminalBunRuntime }).Bun
      : bunOverride;
    const bun = usableBunTerminal(candidate);
    if (bun !== undefined) return Promise.resolve(this.spawnBun(bun, options));
    return this.spawnNodePty(options);
  }

  private spawnBun(bun: HostTerminalBunRuntime, options: TerminalSpawnOptions): TerminalProcess {
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

  private async spawnNodePty(options: TerminalSpawnOptions): Promise<TerminalProcess> {
    const pty = await loadNodePty();
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
