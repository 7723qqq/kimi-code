import type { CoreAPI } from '@moonshot-ai/agent-core';
import type { KapHttpClient } from './http-client';
import type { KapWsClient } from './ws-client';

export interface KapTransportOptions {
  /** KAP server base URL, e.g. 'http://127.0.0.1:58627'. */
  readonly serverUrl: string;
  /** WebSocket client_id; defaults to a generated id. */
  readonly clientId?: string;
  /** Injectable fetch (for tests). Defaults to globalThis.fetch. */
  readonly fetch?: typeof fetch;
  /** Injectable WebSocket factory (for tests). Defaults to `new WebSocket(url)`. */
  readonly webSocketFactory?: (url: string) => WebSocket;
}

export interface CoreProxyContext {
  readonly http: KapHttpClient;
  readonly ws: KapWsClient;
  readonly serverUrl: string;
}

export type CoreApiHandler = (payload: unknown, ctx: CoreProxyContext) => Promise<unknown>;
export type CoreApiHandlerMap = Partial<Record<keyof CoreAPI, CoreApiHandler>>;
