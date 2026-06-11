
import { createDecorator } from '@moonshot-ai/agent-core';
import type { AbortHandler, FsWatchHandler } from '#/ws/connection';

export const WS_PATH = '/api/v1/ws';

export interface IWSGateway {
  readonly _serviceBrand: undefined;

  readonly size: number;

  setAbortHandler(handler: AbortHandler): void;

  setFsWatchHandler(handler: FsWatchHandler): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IWSGateway = createDecorator<IWSGateway>('wsGateway');

export interface WSGatewayOptions {

  pingIntervalMs?: number;

  pongTimeoutMs?: number;
}
