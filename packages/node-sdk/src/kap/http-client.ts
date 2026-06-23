import type { Envelope } from '@moonshot-ai/protocol';

import { mapKapError } from './error-mapping';
import type { KapTransportOptions } from './types';

interface RequestOptions {
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export class KapHttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: KapTransportOptions) {
    this.baseUrl = options.serverUrl.replace(/\/+$/, '') + '/api/v1';
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async get<T>(path: string, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  async delete<T>(path: string, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('DELETE', path, { query });
  }

  private async request<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (options.query !== undefined) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const init: RequestInit = {
      method,
      headers: { 'content-type': 'application/json' },
      signal: options.signal,
    };
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }
    const response = await this.fetchImpl(url, init);
    const envelope = (await response.json()) as Envelope<T>;
    if (envelope.code !== 0) {
      throw mapKapError(envelope.code, envelope.msg, envelope.details);
    }
    return envelope.data as T;
  }
}
