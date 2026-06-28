/**
 * `/api/v2` typed client — `fetch`-based channel + scoped typed proxies.
 *
 *   const client = new RpcClient({ url: 'http://127.0.0.1:58627' });
 *   await client.core<ISessionIndex>('sessions').list(query);
 *   await client.session('abc').service<ISessionMetadata>('session').read();
 *   await client.session('abc').agent('xyz').service<IProfileService>('profile').getModel();
 *
 * The client always `POST`s (the server accepts `GET` too, but the typed client
 * does not need it). The envelope is unwrapped here: a non-zero `code` throws
 * {@link RpcError}; otherwise `data` is returned.
 */

import type { IChannel } from './channel';
import { formatServiceAction } from './channel';

interface Envelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
  readonly request_id: string;
  readonly details?: unknown;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

interface HttpChannelOptions {
  readonly baseUrl: string;
  readonly token?: string;
}

/** A single `resource` channel bound to a scope URL. */
class HttpChannel implements IChannel {
  private readonly baseUrl: string;
  private readonly token?: string;

  constructor(opts: HttpChannelOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
  }

  async call<T>(command: string, arg?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (arg !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(arg);
    }
    if (this.token !== undefined) {
      headers['authorization'] = `Bearer ${this.token}`;
    }
    const res = await fetch(`${this.baseUrl}/${command}`, {
      method: 'POST',
      headers,
      body,
    });
    const envelope = (await res.json()) as Envelope<T>;
    if (envelope.code !== 0) {
      throw new RpcError(envelope.code, envelope.msg, envelope.details);
    }
    return envelope.data;
  }

  listen<T>(_event: string, _arg?: unknown): T {
    throw new Error('events not supported over HTTP; use the WS transport');
  }
}

function makeProxy<T extends object>(channel: IChannel, resource: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      return (arg?: unknown) => channel.call(formatServiceAction(resource, prop), arg);
    },
  });
}

export interface RpcClientOptions {
  /** Base URL of the server, e.g. `http://127.0.0.1:58627`. */
  readonly url: string;
  /** Optional bearer token. */
  readonly token?: string;
}

export class RpcClient {
  private readonly url: string;
  private readonly token?: string;

  constructor(opts: RpcClientOptions) {
    this.url = opts.url.replace(/\/$/, '');
    this.token = opts.token;
  }

  /** Core-scoped resource, e.g. `client.core<ISessionIndex>('sessions')`. */
  core<T extends object>(resource: string): T {
    return makeProxy<T>(
      new HttpChannel({ baseUrl: `${this.url}/api/v2`, token: this.token }),
      resource,
    );
  }

  /** Session scope entry point. */
  session(sessionId: string): SessionRpcClient {
    return new SessionRpcClient(this.url, this.token, sessionId);
  }
}

export class SessionRpcClient {
  private readonly baseUrl: string;

  constructor(
    url: string,
    private readonly token: string | undefined,
    sessionId: string,
  ) {
    this.baseUrl = `${url.replace(/\/$/, '')}/api/v2/session/${encodeURIComponent(sessionId)}`;
  }

  /** Session-scoped resource, e.g. `.service<ISessionMetadata>('session')`. */
  service<T extends object>(resource: string): T {
    return makeProxy<T>(new HttpChannel({ baseUrl: this.baseUrl, token: this.token }), resource);
  }

  /** Agent scope entry point. */
  agent(agentId: string): AgentRpcClient {
    return new AgentRpcClient(this.baseUrl, this.token, agentId);
  }
}

export class AgentRpcClient {
  private readonly baseUrl: string;

  constructor(
    sessionBaseUrl: string,
    private readonly token: string | undefined,
    agentId: string,
  ) {
    this.baseUrl = `${sessionBaseUrl}/agent/${encodeURIComponent(agentId)}`;
  }

  /** Agent-scoped resource, e.g. `.service<IProfileService>('profile')`. */
  service<T extends object>(resource: string): T {
    return makeProxy<T>(new HttpChannel({ baseUrl: this.baseUrl, token: this.token }), resource);
  }
}
