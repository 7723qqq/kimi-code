import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

const CATALOG_TOML = [
  'default_model = "k2"',
  '',
  '[providers.kimi]',
  'type = "kimi"',
  'api_key = "sk-test"',
  'base_url = "https://api.example.test/v1"',
  '',
  '[providers.openai]',
  'type = "openai"',
  '',
  '[models.k2]',
  'provider = "kimi"',
  'model = "kimi-k2"',
  'max_context_size = 131072',
  'display_name = "Kimi K2"',
  'capabilities = ["thinking"]',
  '',
  '[models.turbo]',
  'provider = "kimi"',
  'model = "kimi-turbo"',
  'max_context_size = 32768',
  'display_name = "Kimi Turbo"',
  '',
  '[models.gpt4o]',
  'provider = "openai"',
  'model = "gpt-4o"',
  'max_context_size = 128000',
  '',
].join('\n');

describe('server-v2 /api/v1 model/provider catalog', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-model-catalog-'));
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function boot(toml?: string): Promise<void> {
    if (toml !== undefined) {
      await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
    }
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('lists configured models as selectable aliases', async () => {
    await boot(CATALOG_TOML);
    const { status, body } = await getJson<{ items: unknown[] }>('/api/v1/models');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([
      {
        provider: 'kimi',
        model: 'k2',
        display_name: 'Kimi K2',
        max_context_size: 131072,
        capabilities: ['thinking'],
      },
      {
        provider: 'kimi',
        model: 'turbo',
        display_name: 'Kimi Turbo',
        max_context_size: 32768,
      },
      {
        provider: 'openai',
        model: 'gpt4o',
        display_name: 'gpt-4o',
        max_context_size: 128000,
      },
    ]);
  });

  it('lists providers and returns a single provider by id', async () => {
    await boot(CATALOG_TOML);
    const list = await getJson<{ items: unknown[] }>('/api/v1/providers');
    expect(list.body.code).toBe(0);
    expect(list.body.data.items).toEqual([
      {
        id: 'kimi',
        type: 'kimi',
        base_url: 'https://api.example.test/v1',
        default_model: 'k2',
        has_api_key: true,
        status: 'connected',
        models: ['k2', 'turbo'],
      },
      {
        id: 'openai',
        type: 'openai',
        has_api_key: false,
        status: 'unconfigured',
        models: ['gpt4o'],
      },
    ]);

    const single = await getJson<unknown>('/api/v1/providers/kimi');
    expect(single.body.code).toBe(0);
    expect(single.body.data).toEqual({
      id: 'kimi',
      type: 'kimi',
      base_url: 'https://api.example.test/v1',
      default_model: 'k2',
      has_api_key: true,
      status: 'connected',
      models: ['k2', 'turbo'],
    });
  });

  it('sets the global default model', async () => {
    await boot(CATALOG_TOML);
    const { body } = await postJson<unknown>('/api/v1/models/turbo:set_default', {});
    expect(body.code).toBe(0);
    expect(body.data).toEqual({
      default_model: 'turbo',
      model: {
        provider: 'kimi',
        model: 'turbo',
        display_name: 'Kimi Turbo',
        max_context_size: 32768,
      },
    });
  });

  it('maps unknown provider and model ids to catalog not-found codes', async () => {
    await boot(CATALOG_TOML);
    const provider = await getJson<unknown>('/api/v1/providers/missing');
    expect(provider.body.code).toBe(40412);

    const model = await postJson<unknown>('/api/v1/models/missing:set_default', {});
    expect(model.body.code).toBe(40413);
  });

  it('returns an empty refresh result through the catalog route', async () => {
    await boot(CATALOG_TOML);
    const { status, body } = await postJson<{
      changed: unknown[];
      unchanged: unknown[];
      failed: unknown[];
    }>('/api/v1/providers:refresh_oauth', {});
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ changed: [], unchanged: [], failed: [] });
  });
});
