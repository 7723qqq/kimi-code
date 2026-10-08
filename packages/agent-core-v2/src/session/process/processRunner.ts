import type { Readable, Writable } from 'node:stream';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;
  readonly exitCode: number | null;
  wait(): Promise<number>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  dispose(): Promise<void> | void;
}

export interface ProcessExecOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

export interface ISessionProcessRunner {
  readonly _serviceBrand: undefined;

  readonly terminalBacked?: boolean;

  exec(args: readonly string[], options?: ProcessExecOptions): Promise<IProcess>;
}

export const ISessionProcessRunner: ServiceIdentifier<ISessionProcessRunner> =
  createDecorator<ISessionProcessRunner>('sessionProcessRunner');
