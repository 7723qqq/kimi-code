// apps/kimi-web/src/api/daemon/http.ts
// DaemonHttpClient — REST transport with envelope unwrap and allowCodes support.

import { buildRestUrl } from '../config';
import { DaemonApiError, DaemonNetworkError } from '../errors';
import type { WireEnvelope } from './wire';

export class DaemonHttpClient {
  constructor(private readonly origin: string) {}

  async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>('GET', path, undefined, query);
  }

  async post<T>(path: string, body?: unknown, opts?: { allowCodes?: number[] }): Promise<T> {
    return this.request<T>('POST', path, body, undefined, opts?.allowCodes);
  }

  /** Send multipart/form-data (FormData). Does NOT set Content-Type — browser sets it with boundary. */
  async postForm<T>(path: string, formData: FormData): Promise<T> {
    const url = buildRestUrl(this.origin, path);
    const headers: Record<string, string> = {
      'X-Request-Id': globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2),
    };
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: formData });
    } catch (err) {
      throw new DaemonNetworkError(`Network error calling POST ${path}`, err);
    }
    let envelope: WireEnvelope<T>;
    try {
      envelope = (await response.json()) as WireEnvelope<T>;
    } catch (err) {
      throw new DaemonNetworkError(`Failed to parse JSON response from POST ${path}`, err);
    }
    if (envelope.code !== 0) {
      throw new DaemonApiError({
        code: envelope.code,
        msg: envelope.msg,
        requestId: envelope.request_id,
        details: envelope.details,
      });
    }
    return envelope.data as T;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
    allowCodes: number[] = [],
  ): Promise<T> {
    // Build URL, appending query string (omit undefined values)
    let url = buildRestUrl(this.origin, path);
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          params.set(key, String(value));
        }
      }
      const qs = params.toString();
      if (qs) url = `${url}?${qs}`;
    }

    // Build headers
    const headers: Record<string, string> = {
      'X-Request-Id': globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2),
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }

    // Execute fetch
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new DaemonNetworkError(`Network error calling ${method} ${path}`, err);
    }

    // Parse envelope
    let envelope: WireEnvelope<T>;
    try {
      envelope = (await response.json()) as WireEnvelope<T>;
    } catch (err) {
      throw new DaemonNetworkError(`Failed to parse JSON response from ${method} ${path}`, err);
    }

    // Unwrap: code 0 = success; allowed non-zero = return data; else throw
    if (envelope.code !== 0 && !allowCodes.includes(envelope.code)) {
      throw new DaemonApiError({
        code: envelope.code,
        msg: envelope.msg,
        requestId: envelope.request_id,
        details: envelope.details,
      });
    }

    // For both code=0 and allowed non-zero codes, return the data field.
    // Callers that pass allowCodes handle the null/non-null data themselves.
    return envelope.data as T;
  }
}
