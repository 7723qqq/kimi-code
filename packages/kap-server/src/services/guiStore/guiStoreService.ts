import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {Error2} from '@moonshot-ai/agent-core-v2';
import { ErrorCodes } from '@moonshot-ai/agent-core-v2/errors';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import type { IGuiStoreService } from './guiStore';

export interface GuiStoreLogger {
  warn(obj: unknown, msg: string): void;
  error(obj: unknown, msg: string): void;
}

const noopLogger: GuiStoreLogger = { warn: () => {}, error: () => {} };

function emptyStore(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

type ReadResult =
  | { ok: true; store: Record<string, string> }
  | { ok: false; reason: string };

export class GuiStoreService implements IGuiStoreService {
  readonly _serviceBrand: undefined;

  private readonly filePath: string;
  private readonly logger: GuiStoreLogger;
  private queue: Promise<void> = Promise.resolve();

  constructor(homeDir: string, logger?: GuiStoreLogger) {
    this.filePath = join(homeDir, 'gui.toml');
    this.logger = logger ?? noopLogger;
  }

  async getItem(key: string): Promise<string | null> {
    const result = await this.readAll();
    if (!result.ok) return null;
    const all = result.store;
    if (!Object.prototype.hasOwnProperty.call(all, key)) return null;
    return all[key] ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.withLock(async () => {
      const all = await this.readWritable();
      all[key] = value;
      await this.writeAll(all);
    });
  }

  async removeItem(key: string): Promise<void> {
    await this.withLock(async () => {
      const all = await this.readWritable();
      if (Object.prototype.hasOwnProperty.call(all, key)) {
        delete all[key];
        await this.writeAll(all);
      }
    });
  }

  async clear(): Promise<void> {
    await this.withLock(() => this.writeAll(emptyStore()));
  }

  async length(): Promise<number> {
    const result = await this.readAll();
    return result.ok ? Object.keys(result.store).length : 0;
  }

  private async readWritable(): Promise<Record<string, string>> {
    const result = await this.readAll();
    if (!result.ok) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `gui.toml is unreadable (${result.reason}); refusing to overwrite ${this.filePath}`,
      );
    }
    return result.store;
  }

  private withLock(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readAll(): Promise<ReadResult> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: true, store: emptyStore() };
      }
      throw error;
    }
    if (text.trim().length === 0) return { ok: true, store: emptyStore() };
    let parsed: Record<string, unknown>;
    try {
      parsed = parseToml(text) as Record<string, unknown>;
    } catch (error) {
      this.logger.error(
        { filePath: this.filePath, err: error },
        'gui.toml parse failed; writes are refused until the file is fixed or cleared',
      );
      return { ok: false, reason: `parse failed: ${(error as Error).message}` };
    }
    const out = emptyStore();
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') {
        out[k] = v;
      } else {
        this.logger.warn(
          { filePath: this.filePath, key: k, type: v === null ? 'null' : typeof v },
          'gui.toml has a non-string value; writes are refused until the file is fixed or cleared',
        );
        return { ok: false, reason: `key ${JSON.stringify(k)} is not a string` };
      }
    }
    return { ok: true, store: out };
  }

  private async writeAll(obj: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const plain: Record<string, string> = { ...obj };
    const text = Object.keys(plain).length === 0 ? '' : stringifyToml(plain);
    const tmp = `${this.filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, text, { encoding: 'utf-8', mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}
