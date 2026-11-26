import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDesktopBackend, type DesktopBackend } from '../../../src/backend/desktopBackend';

describe('desktop Bun backend', () => {
  let home: string;
  let backend: DesktopBackend;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-desktop-backend-'));
    backend = await startDesktopBackend({
      homeDir: home,
      disableAuth: true,
      serverVersion: '0.0.0-test',
      identity: { productName: 'test-desktop', version: '0.0.0-test', platform: 'test' },
    });
  });

  afterAll(async () => {
    await backend.close();
    await rm(home, { recursive: true, force: true });
  });

  it('serves the KAP meta endpoint from the Bun process', async () => {
    const response = await fetch(`${backend.origin}/api/v1/meta`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { code: number; data?: unknown };
    expect(body.code).toBe(0);
    expect(body.data).toBeDefined();
  });
});
