/**
 * `terminal` domain (L6) — interactive terminal (PTY) contract.
 *
 * Defines the `ISessionTerminalService` that business code (and the edge, via an
 * accessor borrow) uses to manage a session's interactive terminals, the
 * `ISessionTerminalBackend` provider that hides the local/ssh/container split, and
 * the attach/stream types (`TerminalProcess`, `TerminalAttachSink`,
 * `TerminalFrame`) used to wire terminal I/O to a transport. Session-scoped:
 * one `ISessionTerminalService` owns only its own session's terminals. Wire types
 * (`Terminal`, `CreateTerminalRequest`, frame messages) are sourced from
 * `@moonshot-ai/protocol`.
 */

import type {
  CreateTerminalRequest,
  Terminal,
  TerminalExitMessage,
  TerminalOutputMessage,
} from '@moonshot-ai/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export type { CreateTerminalRequest, Terminal, TerminalExitMessage, TerminalOutputMessage };

export type TerminalFrame = TerminalOutputMessage | TerminalExitMessage;

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
  readonly onData: Event<string>;
  readonly onExit: Event<{ exitCode: number | null }>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface ISessionTerminalService {
  readonly _serviceBrand: undefined;

  create(input: CreateTerminalRequest): Promise<Terminal>;

  list(): Promise<readonly Terminal[]>;

  get(terminalId: string): Promise<Terminal>;

  attach(
    terminalId: string,
    sink: TerminalAttachSink,
    options?: TerminalAttachOptions,
  ): Promise<{ replayed: number }>;

  detach(terminalId: string, sinkId: string): void;

  detachAllForSink(sinkId: string): void;

  write(terminalId: string, data: string): Promise<void>;

  resize(terminalId: string, cols: number, rows: number): Promise<void>;

  close(terminalId: string): Promise<{ closed: true }>;
}

export const ISessionTerminalService: ServiceIdentifier<ISessionTerminalService> =
  createDecorator<ISessionTerminalService>('sessionTerminalService');

export interface ISessionTerminalBackend {
  readonly _serviceBrand: undefined;

  spawn(options: TerminalSpawnOptions): Promise<TerminalProcess>;
}

export const ISessionTerminalBackend: ServiceIdentifier<ISessionTerminalBackend> =
  createDecorator<ISessionTerminalBackend>('sessionTerminalBackend');
