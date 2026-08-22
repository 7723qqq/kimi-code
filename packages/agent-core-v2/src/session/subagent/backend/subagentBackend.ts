import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const SUBAGENT_BACKEND_NAMES = ['claude-code', 'codex', 'acp'] as const;

export type SubagentBackendName = (typeof SUBAGENT_BACKEND_NAMES)[number];

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
