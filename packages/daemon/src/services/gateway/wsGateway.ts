

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';

import { Disposable, createDecorator } from '@moonshot-ai/agent-core';
import { WebSocketServer, type WebSocket } from 'ws';

import { IConnectionRegistry } from './connectionRegistry';
import { ILogService } from '@moonshot-ai/services';
import { IRestGateway } from './restGateway';
import { ISessionClientsService } from './sessionClients';
import { WsConnection, type AbortHandler, type FsWatchHandler } from '#/ws/connection';

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

