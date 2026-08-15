/**
 * `subagent` domain — external subagent backend contract.
 *
 * A backend runs one subagent turn outside the in-process agent engine:
 * `claude-code` (Claude Code CLI via its SDK), `codex` (OpenAI Codex
 * app-server over stdio JSON-RPC), or `acp` (any Agent Client Protocol
 * implementation). Each backend exposes a uniform `start` that returns a run
 * handle with a result promise and a disposer; the `Agent` tool dispatches to
 * a backend by name and adapts the run into its task/notification surface.
 * The in-process engine path is not a backend — it stays the tool's default
 * and keeps its existing lifecycle. Bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type SubagentBackendName = 'claude-code' | 'codex' | 'acp';

export type SubagentBackendStopReason =
  | 'completed'
  | 'aborted'
  | 'error'
  | 'max-tokens'
  | 'refusal';

export interface SubagentBackendStartRequest {
  readonly prompt: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

export interface SubagentBackendResult {
  readonly output: string;
  readonly stopReason: SubagentBackendStopReason;
}

export interface SubagentBackendRun {
  readonly id: string;
  readonly result: Promise<SubagentBackendResult>;
  dispose(): Promise<void>;
}

export interface ISubagentBackend {
  readonly name: SubagentBackendName;
  start(request: SubagentBackendStartRequest): Promise<SubagentBackendRun>;
}

export interface ISubagentBackendService {
  readonly _serviceBrand: undefined;

  getBackend(name: SubagentBackendName): ISubagentBackend | undefined;

  list(): readonly ISubagentBackend[];
}

export const ISubagentBackendService: ServiceIdentifier<ISubagentBackendService> =
  createDecorator<ISubagentBackendService>('subagentBackendService');
