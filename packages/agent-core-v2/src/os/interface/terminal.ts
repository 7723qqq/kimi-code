import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import { isoDateTimeSchema } from '#/_base/utils/isoDateTime';

const relativeCwdSchema = z
  .string()
  .min(1)
  .refine((value) => !isAbsolutePath(value), 'cwd must be relative to the session workspace');

export const terminalStatusSchema = z.enum(['running', 'exited']);
export type TerminalStatus = z.infer<typeof terminalStatusSchema>;

export const terminalSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  shell: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  status: terminalStatusSchema,
  created_at: isoDateTimeSchema,
  exited_at: isoDateTimeSchema.optional(),
  exit_code: z.number().int().nullable().optional(),
});
export type Terminal = z.infer<typeof terminalSchema>;

export const createTerminalRequestSchema = z.object({
  runtime_id: z.string().min(1),
  cwd: relativeCwdSchema.optional(),
  shell: z.string().min(1).optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
});
export type CreateTerminalRequest = z.infer<typeof createTerminalRequestSchema>;

export interface TerminalOutputMessage {
  type: 'terminal_output';
  seq: number;
  session_id: string;
  terminal_id: string;
  timestamp: string;
  payload: { data: string };
}

export interface TerminalExitMessage {
  type: 'terminal_exit';
  session_id: string;
  terminal_id: string;
  timestamp: string;
  payload: { exit_code?: number | null | undefined };
}

export type TerminalFrame = TerminalOutputMessage | TerminalExitMessage;

function isAbsolutePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

export interface TerminalAttachSink {
  readonly id: string;
  send(frame: TerminalFrame): void;
}

export interface TerminalAttachOptions {
  readonly sinceSeq?: number;
}

export interface TerminalSpawnOptions {
  readonly cwd: string;
  readonly shell: string;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalProcess {
  readonly onProcessData: Event<string>;
  readonly onProcessExit: Event<{ exitCode: number | null }>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** The subset of Bun's global used by the Bun.Terminal PTY path. */
export interface HostTerminalBunTerminal {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** A Bun subprocess carrying an interactive {@link HostTerminalBunTerminal}. */
export interface HostTerminalBunSubprocess {
  readonly terminal: HostTerminalBunTerminal;
  readonly exited: Promise<number | null>;
  kill(): void;
}

/** Shape of the host `Bun` global relevant to terminal spawning. */
export interface HostTerminalBunRuntime {
  readonly Terminal?: unknown;
  spawn(
    command: readonly string[],
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      terminal: {
        name?: string;
        cols?: number;
        rows?: number;
        data(terminal: HostTerminalBunTerminal, data: Uint8Array): void;
      };
    },
  ): HostTerminalBunSubprocess;
}

export interface IHostTerminalService {
  readonly _serviceBrand: undefined;

  /**
   * Spawn an interactive terminal process.
   *
   * @param bunOverride Backend selection seam for tests and embedders: a
   * Bun-like runtime object routes through Bun.Terminal when it carries one,
   * `null` forces the node-pty path regardless of host runtime, and omission
   * auto-detects from `globalThis.Bun`.
   */
  spawn(
    options: TerminalSpawnOptions,
    bunOverride?: HostTerminalBunRuntime | null,
  ): Promise<TerminalProcess>;
}

export const IHostTerminalService: ServiceIdentifier<IHostTerminalService> =
  createDecorator<IHostTerminalService>('hostTerminalService');
