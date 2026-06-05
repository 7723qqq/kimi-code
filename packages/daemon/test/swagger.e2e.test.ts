/**
 * OpenAPI / Swagger UI smoke test.
 *
 * Asserts that `@fastify/swagger` and `@fastify/swagger-ui` are wired
 * correctly and that the generated OpenAPI document covers the daemon's
 * REST surface.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IRestGateway, startDaemon, type RunningDaemon } from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-daemon-swagger-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-daemon-swagger-home-'));
});

afterEach(async () => {
  try {
    await daemon?.close();
  } catch {
    // ignore
  }
  daemon = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function bootDaemon(): Promise<RunningDaemon> {
  daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    bridgeOptions: { homeDir: bridgeHome },
  });
  return daemon;
}

function appOf(r: RunningDaemon): {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown; payload: string }>;
} {
  return r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
      inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown; payload: string }>;
    };
  });
}

describe('Swagger / OpenAPI', () => {
  it('/documentation/json returns a valid OpenAPI document', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({ method: 'GET', url: '/documentation/json' });
    expect(res.statusCode).toBe(200);

    const doc = res.json() as Record<string, unknown>;
    expect(doc.openapi).toMatch(/^3\.\d+\.\d+$/);
    expect(typeof doc.info).toBe('object');
    expect((doc.info as Record<string, unknown>)['title']).toBe('Kimi Code Daemon API');
    expect(typeof (doc.info as Record<string, unknown>)['version']).toBe('string');

    const paths = doc.paths as Record<string, unknown>;
    expect(paths['/api/v1/healthz']).toBeDefined();
    expect(paths['/api/v1/meta']).toBeDefined();
    expect(paths['/api/v1/sessions']).toBeDefined();
    expect(paths['/api/v1/tools']).toBeDefined();
    expect(paths['/api/v1/files']).toBeDefined();
  });

  it('/documentation returns the Swagger UI HTML', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({ method: 'GET', url: '/documentation' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('swagger-ui');
  });
});
