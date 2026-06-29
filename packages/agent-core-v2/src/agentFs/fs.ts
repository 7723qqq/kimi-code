/**
 * `agentFs` domain (L2) — wire-shaped filesystem operations.
 *
 * Defines the `IFsService` that backs the fs REST surface: content search,
 * content grep, and git status/diff. It is the higher-level counterpart to
 * `IAgentFileSystem` (the thin IO primitive): it orchestrates the IO primitive
 * plus `IProcessRunner` (for `rg` / `git` / `gh`) and returns protocol-shaped
 * responses. Session-scoped — the scope itself is the session, so no
 * `sessionId` is threaded through.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type {
  FsDiffRequest,
  FsDiffResponse,
  FsGitStatusRequest,
  FsGitStatusResponse,
  FsGrepRequest,
  FsGrepResponse,
  FsSearchRequest,
  FsSearchResponse,
} from '@moonshot-ai/protocol';

export interface IFsService {
  readonly _serviceBrand: undefined;

  search(req: FsSearchRequest): Promise<FsSearchResponse>;
  grep(req: FsGrepRequest): Promise<FsGrepResponse>;
  gitStatus(req: FsGitStatusRequest): Promise<FsGitStatusResponse>;
  diff(req: FsDiffRequest): Promise<FsDiffResponse>;
}

export const IFsService: ServiceIdentifier<IFsService> =
  createDecorator<IFsService>('fsService');
