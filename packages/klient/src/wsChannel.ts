/**
 * `WsChannel` — an `IChannel` bound to one Service that forwards `call`s over
 * the shared `/api/v2/ws` socket instead of HTTP. Same VS Code shape as
 * `HttpChannel` (the URL equivalent is the `{scope, service, ids}` triple the
 * socket puts on each frame), so the same `makeProxy` turns it into a typed
 * Service client. `listen` here takes a handler and returns a subscription
 * that survives reconnects until disposed.
 */

import type { IChannel } from './channel.js';
import type { WsScopeIds, WsScopeKind, WsSocket, WsSubscription } from './wsSocket.js';

export interface WsChannelOptions {
  readonly socket: WsSocket;
  readonly scope: WsScopeKind;
  /** Service channel name (the decorator id, `String(id)`). */
  readonly service: string;
  readonly sessionId?: string;
  readonly agentId?: string;
}

export class WsChannel implements IChannel {
  private readonly socket: WsSocket;
  private readonly scope: WsScopeKind;
  private readonly service: string;
  private readonly ids: WsScopeIds;

  constructor(opts: WsChannelOptions) {
    this.socket = opts.socket;
    this.scope = opts.scope;
    this.service = opts.service;
    this.ids = { sessionId: opts.sessionId, agentId: opts.agentId };
  }

  call<T>(command: string, arg?: unknown): Promise<T> {
    return this.socket.call(this.scope, this.service, command, arg, this.ids);
  }

  /** Subscribe to an event stream in this channel's scope; dispose to unlisten. */
  listen(event: string, handler: (data: unknown) => void): WsSubscription {
    return this.socket.listen(this.scope, event, this.ids, handler);
  }
}
