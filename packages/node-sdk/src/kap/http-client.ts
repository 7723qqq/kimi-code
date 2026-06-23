import type { KapTransportOptions } from './types';

export class KapHttpClient {
  protected readonly baseUrl: string;
  protected readonly fetchImpl: typeof fetch;

  constructor(options: KapTransportOptions) {
    this.baseUrl = options.serverUrl.replace(/\/+$/, '') + '/api/v1';
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
}
