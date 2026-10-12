import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { syncDir } from '#/utils/fs';

export const PENDING_MAX = 1000;
const STDERR_NOTICE_INTERVAL_MS = 30_000;

class AsyncSerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => {});
    return next;
  }
}

export interface Sink {
  enqueue(line: string): void;
  flush(): Promise<boolean>;
  close(): Promise<void>;
  flushSync(): void;
}

interface RotatingFileSinkOptions {
  readonly path: string;
  readonly maxBytes: number;
  readonly files: number;
}

export class RotatingFileSink implements Sink {
  private readonly queue = new AsyncSerialQueue();
  private pending: string[] = [];
  private dropped = 0;
  private closed = false;
  private lastStderrNotice = 0;
  private currentBytes = -1;
  private directorySynced = false;

  constructor(private readonly options: RotatingFileSinkOptions) {}

  enqueue(line: string): void {
    if (this.closed) return;
    if (this.pending.length >= PENDING_MAX) {
      this.pending.shift();
      this.dropped++;
    }
    this.pending.push(line);
    this.scheduleDrain();
  }

  async flush(): Promise<boolean> {
    return this.queue.run(() => this.drain());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // The flag is set before the final flush so that a drain queued by a
    // previous `enqueue` microtask cannot re-own the batch between
    // `restorePending` and the drop report below; the final flush itself still
    // runs because `drain` does not consult `closed`. New lines are refused
    // from here on, which is the same guarantee `enqueue`/`flushSync` gave
    // before.
    this.closed = true;
    try {
      await this.flush();
    } catch {}
    if (this.pending.length > 0) {
      // Deliberately not rate-limited: a batch lost on close is the last
      // chance to say those lines ever existed.
      const dropped = this.pending.length;
      this.pending = [];
      this.writeStderr(`[logger] dropped ${dropped} buffered entries on close\n`);
    }
  }

  flushSync(): void {
    if (this.closed || this.pending.length === 0) return;
    try {
      mkdirSync(dirname(this.options.path), { recursive: true });
      const body = this.pending.join('') + this.takeDroppedNotice();
      this.pending = [];
      appendFileSync(this.options.path, body);
    } catch (error) {
      this.noteFailure(error);
    }
  }

  private scheduleDrain(): void {
    if (this.closed) return;
    queueMicrotask(() => {
      if (this.closed || this.pending.length === 0) return;
      this.queue.run(() => this.drain()).catch(() => {});
    });
  }

  private async drain(): Promise<boolean> {
    if (this.pending.length === 0) return true;
    const droppedLine = this.takeDroppedNotice();
    const lines = droppedLine === '' ? [...this.pending] : [...this.pending, droppedLine];
    this.pending = [];
    let appended = 0;
    let failure: unknown;
    try {
      await mkdir(dirname(this.options.path), { recursive: true });
      if (this.currentBytes < 0) {
        this.currentBytes = await this.statSize(this.options.path);
      }
      const result = await this.appendLines(lines);
      appended = result.appended;
      failure = result.error;

      if (failure === undefined && !this.directorySynced) {
        await syncDir(dirname(this.options.path));
        this.directorySynced = true;
      }
    } catch (error) {
      failure = error;
    }

    if (failure !== undefined) {
      this.noteFailure(failure);
      // Only the lines that never reached the file are put back: everything
      // up to `appended` is already durable, and re-queuing it would write
      // those lines a second time once the sink recovers.
      this.restorePending(lines.slice(appended));
      return false;
    }
    return true;
  }

  private restorePending(lines: readonly string[]): void {
    const restored = [...lines, ...this.pending];
    const overflow = restored.length - PENDING_MAX;
    if (overflow <= 0) {
      this.pending = restored;
      return;
    }
    this.dropped += overflow;
    this.pending = restored.slice(overflow);
  }

  private async appendLines(
    lines: readonly string[],
  ): Promise<{ appended: number; error?: unknown }> {
    let appended = 0;
    let chunk = '';
    let chunkBytes = 0;
    let chunkLines = 0;
    try {
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line, 'utf-8');
        if (
          chunkBytes > 0 &&
          (chunkBytes + lineBytes > this.options.maxBytes ||
            this.currentBytes + chunkBytes + lineBytes > this.options.maxBytes)
        ) {
          await this.appendChunk(chunk);
          appended += chunkLines;
          await this.rotateIfFull();
          chunk = '';
          chunkBytes = 0;
          chunkLines = 0;
        }

        if (
          chunkBytes === 0 &&
          this.currentBytes > 0 &&
          this.currentBytes + lineBytes > this.options.maxBytes
        ) {
          await this.rotate();
        }

        chunk += line;
        chunkBytes += lineBytes;
        chunkLines += 1;
      }
      if (chunkBytes > 0) {
        await this.appendChunk(chunk);
        appended += chunkLines;
        await this.rotateIfFull();
      }
    } catch (error) {
      return { appended, error };
    }
    return { appended };
  }

  private async appendChunk(chunk: string): Promise<void> {
    const fh = await open(this.options.path, 'a');
    try {
      await fh.appendFile(chunk, 'utf-8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    this.currentBytes += Buffer.byteLength(chunk, 'utf-8');
  }

  private async rotateIfFull(): Promise<void> {
    if (this.currentBytes >= this.options.maxBytes) {
      await this.rotate();
    }
  }

  private async rotate(): Promise<void> {
    const { path, files } = this.options;
    for (let i = files - 2; i >= 1; i--) {
      const from = `${path}.${i}`;
      const to = `${path}.${i + 1}`;
      try {
        await rename(from, to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    try {
      await rename(path, `${path}.1`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await unlink(`${path}.${files}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.currentBytes = 0;
    this.directorySynced = false;
  }

  private async statSize(p: string): Promise<number> {
    try {
      const s = await stat(p);
      return s.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  private takeDroppedNotice(): string {
    if (this.dropped === 0) return '';
    const line = `... dropped ${this.dropped} entries ...\n`;
    this.dropped = 0;
    return line;
  }

  private noteFailure(error: unknown): void {
    const now = Date.now();
    if (now - this.lastStderrNotice < STDERR_NOTICE_INTERVAL_MS) return;
    this.lastStderrNotice = now;
    const code = (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
    this.writeStderr(`[logger] write failed: ${code}\n`);
  }

  private writeStderr(line: string): void {
    try {
      process.stderr.write(line);
    } catch {}
  }
}
