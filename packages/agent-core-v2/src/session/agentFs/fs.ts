/**
 * `agentFs` domain (L2) — wire-shaped filesystem operations.
 *
 * Defines the `ISessionFsService` that backs the fs REST surface: content search,
 * content grep, and git status/diff. It is the higher-level counterpart to
 * `ISessionAgentFileSystem` (the thin IO primitive): it orchestrates the IO primitive
 * plus `ISessionProcessRunner` (for `rg` / `git` / `gh`) and returns protocol-shaped
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
  FsListManyRequest,
  FsListManyResponse,
  FsListRequest,
  FsListResponse,
  FsMkdirRequest,
  FsMkdirResponse,
  FsReadRequest,
  FsReadResponse,
  FsSearchRequest,
  FsSearchResponse,
  FsStatManyRequest,
  FsStatManyResponse,
  FsStatRequest,
  FsStatResponse,
} from '@moonshot-ai/protocol';

/** Absolute + workspace-relative path resolution for a session file. */
export interface FsPathResolved {
  readonly absolute: string;
  readonly relative: string;
  readonly isDirectory: boolean;
}

/** Metadata needed by the download route to stream a session file. */
export interface FsDownloadResolved {
  readonly absolute: string;
  readonly relative: string;
  readonly size: number;
  readonly etag: string;
  readonly mime: string;
  readonly modifiedAt: Date;
}

export interface ISessionFsService {
  readonly _serviceBrand: undefined;

  list(req: FsListRequest): Promise<FsListResponse>;
  read(req: FsReadRequest): Promise<FsReadResponse>;
  listMany(req: FsListManyRequest): Promise<FsListManyResponse>;
  stat(req: FsStatRequest): Promise<FsStatResponse>;
  statMany(req: FsStatManyRequest): Promise<FsStatManyResponse>;
  mkdir(req: FsMkdirRequest): Promise<FsMkdirResponse>;
  search(req: FsSearchRequest): Promise<FsSearchResponse>;
  grep(req: FsGrepRequest): Promise<FsGrepResponse>;
  gitStatus(req: FsGitStatusRequest): Promise<FsGitStatusResponse>;
  diff(req: FsDiffRequest): Promise<FsDiffResponse>;
  resolvePath(relPath: string): Promise<FsPathResolved>;
  resolveDownload(relPath: string): Promise<FsDownloadResolved>;
}

export const ISessionFsService: ServiceIdentifier<ISessionFsService> =
  createDecorator<ISessionFsService>('sessionFsService');
