/**
 * `tools` domain — `IProcess` adapter over the Rust bash process lifecycle.
 *
 * Bridges the native `nativeBashSpawn` handle (streamed stdout/stderr events,
 * exit result, tree kill) onto the `IProcess` contract the Bash tool and
 * `ProcessTask` consume. stdout/stderr are `PassThrough` streams fed by the
 * native events; `wait()` settles from the native exit cache (raced against
 * the `exit` event so both paths resolve exactly once).
 *
 * stdin is a no-op writable: the native handle closes stdin at spawn, which
 * matches the Bash tool's only stdin usage (`proc.stdin.end()` = EOF).
 */

import { PassThrough, Writable } from 'node:stream';
import type { Writable as WritableStream } from 'node:stream';

import {
  tryNativeBashDispose,
  tryNativeBashKill,
  tryNativeBashWait,
  type NativeBashEvent,
} from '#/_base/native-tools';
import type { IProcess } from '#/session/process/processRunner';

export class NativeBashProcess implements IProcess {
  declare readonly _serviceBrand: undefined;

  readonly stdin: WritableStream;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly pid: number;

  private readonly id: number;
  private exitCodeValue: number | null = null;
  private readonly exitPromise: Promise<number>;
  private resolveExit!: (code: number) => void;
  private disposed = false;

  constructor(id: number, pid: number) {
    this.id = id;
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (_chunk, _encoding, callback) => callback(),
    });
    this.exitPromise = new Promise<number>((resolve) => {
      this.resolveExit = resolve;
    });
    void this.armWait();
  }

  get exitCode(): number | null {
    return this.exitCodeValue;
  }

  /** Feed a native lifecycle event into the streams / exit promise. */
  handleEvent(event: NativeBashEvent): void {
    if (event.kind === 'stdout') {
      this.stdout.write(event.data ?? '');
      return;
    }
    if (event.kind === 'stderr') {
      this.stderr.write(event.data ?? '');
      return;
    }
    if (event.kind === 'exit') {
      this.settleExit(event.exitCode ?? -1);
      return;
    }
    if (event.kind === 'error') {
      this.settleExit(-1);
    }
  }

  async wait(): Promise<number> {
    return this.exitPromise;
  }

  async kill(_signal?: NodeJS.Signals): Promise<void> {
    tryNativeBashKill(this.id);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    tryNativeBashDispose(this.id);
    this.stdout.destroy();
    this.stderr.destroy();
    this.stdin.destroy();
  }

  /**
   * Race the native exit cache against the streamed `exit` event. Whichever
   * settles first wins; the other path is a no-op (promise resolution is
   * idempotent, and `exitCodeValue` guards against overwrites).
   */
  private async armWait(): Promise<void> {
    try {
      const exit = await tryNativeBashWait(this.id);
      if (exit !== undefined && this.exitCodeValue === null) {
        this.settleExit(exit.exitCode);
      }
    } catch {
      // The handle may already be disposed; the exit event path covers it.
    }
  }

  private settleExit(code: number): void {
    if (this.exitCodeValue === null) {
      this.exitCodeValue = code;
    }
    this.stdout.end();
    this.stderr.end();
    this.resolveExit(this.exitCodeValue);
  }
}
