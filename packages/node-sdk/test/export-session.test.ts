import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness, type KimiError } from '#/index';

import { recordingTelemetry, type TelemetryRecord } from './telemetry';
import { TEST_IDENTITY } from './test-identity';

// agent-core/node-sdk normalize paths to forward slashes (pathe). Mirror that
// in path assertions so they hold on Windows, where node:path produces
// backslashes.
const toPosix = (p: string): string => p.replaceAll('\\', '/');

const tempDirs: string[] = [];

/**
 * Windows keeps file handles (antivirus, fs watchers, lazy flush) alive briefly
 * after close, so a bare `rm` can fail with ENOTEMPTY/EBUSY/EPERM. Retry
 * briefly before giving up.
 */
async function removeDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  await rm(dir, { recursive: true, force: true });
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await removeDirWithRetry(dir);
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-export-'));
  tempDirs.push(dir);
  return dir;
}

describe('KimiHarness.exportSession', () => {
  it('exports a created session through the public Harness API', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
    });

    const session = await harness.createSession({
      id: 'ses_harness_export',
      workDir,
    });
    const sessionDir = (await harness.listSessions({ workDir })).find(
      (item) => item.id === session.id,
    )!.sessionDir;
    await writeFile(join(sessionDir, 'wire.jsonl'), '{}\n', 'utf-8');
    await mkdir(join(sessionDir, 'subagents'), { recursive: true });
    await writeFile(join(sessionDir, 'subagents', 'demo.txt'), 'demo', 'utf-8');

    const outputPath = join(workDir, 'export.zip');
    const result = await harness.exportSession({
      id: session.id,
      outputPath,
      version: '1.0.0-test',
    });

    expect(result.zipPath).toBe(toPosix(outputPath));
    expect(result.entries).toContain('manifest.json');
    expect(result.entries).toContain('state.json');
    expect(result.entries).toContain('wire.jsonl');
    expect(result.entries).toContain('subagents/demo.txt');
    expect(result.manifest.sessionId).toBe(session.id);
    expect(records).toContainEqual({
      event: 'export',
      sessionId: session.id,
      properties: undefined,
    });
  });

  it('rejects missing session ids', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    const missingExport = harness.exportSession({ id: 'ses_missing', version: '1.0.0-test' });
    await expect(missingExport).rejects.toMatchObject({
      code: 'session.not_found',
      details: { sessionId: 'ses_missing' },
    } satisfies Partial<KimiError>);
  });
});