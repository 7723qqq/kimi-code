import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { TestkitError } from '#/errors';

export interface NodeCommand {
  readonly entry: string;
  readonly imports?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export function killProcessTree(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new RangeError('Expected a child process ID');
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      return;
    }
  }
}

export async function readNetworkViolations(path: string, label = 'The child process'): Promise<readonly string[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TestkitError(`${label} did not load the testkit network guard preload (no log at ${path})`, { cause: error });
    }
    throw error;
  }
  return text.split(/\r?\n/).filter((line) => line !== '');
}
