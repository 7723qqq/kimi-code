/**
 * `agentFs` domain (L1) — the Agent's filesystem.
 *
 * Defines the `IAgentFileSystem` that business code injects to read and write
 * files inside the Agent's execution environment. Session-scoped and backed by
 * the session `IKaos`; business code depends on `IAgentFileSystem` only.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface AgentFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
}

export interface IAgentFileSystem {
  readonly _serviceBrand: undefined;

  readonly cwd: string;

  readText(path: string): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  readBytes(path: string, n?: number): Promise<Uint8Array>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  stat(path: string): Promise<AgentFileStat>;
  readdir(path: string): Promise<readonly string[]>;
  glob(pattern: string): Promise<readonly string[]>;
  mkdir(path: string): Promise<void>;
  withCwd(cwd: string): IAgentFileSystem;
}

export const IAgentFileSystem: ServiceIdentifier<IAgentFileSystem> =
  createDecorator<IAgentFileSystem>('agentFileSystem');
