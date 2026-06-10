

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  createDecorator,
  Disposable,
  type IDisposable,
} from '@moonshot-ai/agent-core';
import {
  ISessionService,
  SessionNotFoundError,
} from '../session/session';
import type {
  FsGrepFileHit,
  FsGrepMatch,
  FsGrepRequest,
  FsGrepResponse,
  FsSearchHit,
  FsSearchRequest,
  FsSearchResponse,
} from '@moonshot-ai/protocol';
import ignore, { type Ignore } from 'ignore';

import { ILogService } from '../logger/logger';
import {
  FsPathEscapesError,
  resolveSafePath,
} from './fsPathSafety';

export class FsGrepTimeoutError extends Error {
  readonly elapsedMs: number;
  constructor(elapsedMs: number) {
    super(`fs.grep_timeout after ${elapsedMs}ms`);
    this.name = 'FsGrepTimeoutError';
    this.elapsedMs = elapsedMs;
  }
}

export interface IFsSearchService extends IDisposable {
  readonly _serviceBrand: undefined;

  search(
    sessionId: string,
    req: FsSearchRequest,
  ): Promise<FsSearchResponse>;
  grep(sessionId: string, req: FsGrepRequest): Promise<FsGrepResponse>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IFsSearchService = createDecorator<IFsSearchService>(
  'fsSearchService',
);

const SEARCH_HARD_CAP = 500;

const GREP_TIMEOUT_MS = 30_000;

const WALK_MAX_DEPTH = 64;

void FsPathEscapesError;
void SessionNotFoundError;
