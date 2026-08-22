import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import { SpillLocator, type ISpillService } from '#/features/spill/spill';
import { SpillService } from '#/features/spill/spillService';
import { encodeSegment, saveTextFile, sessionDir } from '#/features/spill/spillStore';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';

const scratchDirs: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-spill-test-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
  }
});

function sessionStub(sessionId = 'test-session'): ISessionContext {
  return { _serviceBrand: undefined, sessionId } as unknown as ISessionContext;
}

function configStub(root: string | undefined): IConfigService {
  return {
    get: <T>(section: string): T | undefined => (section === 'spill' ? ({ root } as T) : undefined),
  } as unknown as IConfigService;
}

function spillService(root: string | undefined, sessionId = 'test-session'): SpillService {
  return new SpillService(configStub(root), sessionStub(sessionId));
}

describe('spillStore encodeSegment', () => {
  it('keeps safe characters literal and escapes everything else injectively', () => {
    expect(encodeSegment('bash-output.txt')).toBe('bash-output.txt');
    expect(encodeSegment('a/b\\c')).toBe('a~002Fb~005Cc');
    expect(encodeSegment('../evil')).toBe('..~002Fevil');
    expect(encodeSegment('C:\\x')).toBe('C~003A~005Cx');
  });

  it('escapes tilde, dot segments, and the empty string', () => {
    expect(encodeSegment('~')).toBe('~007E');
    expect(encodeSegment('.')).toBe('~002E');
    expect(encodeSegment('..')).toBe('~002E~002E');
    expect(encodeSegment('')).toBe('~');
  });

  it('neutralizes NUL and control characters', () => {
    expect(encodeSegment('a\u0000b')).toBe('a~0000b');
    expect(encodeSegment('a\u0007b')).toBe('a~0007b');
  });
});

describe('spillStore saveTextFile', () => {
  it('writes into the session-scoped directory with an unpredictable name', async () => {
    const root = scratchDir();
    const saved = await saveTextFile({
      root,
      sessionId: 'sess-1',
      suggestedName: 'out.txt',
      content: 'hello spill',
    });
    expect(saved.bytes).toBe(11);
    const dir = sessionDir(root, 'sess-1');
    expect(saved.path.startsWith(dir)).toBe(true);
    expect(join(dir, 'out.txt')).not.toBe(saved.path);
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o700).toBe(0o700);
      expect(statSync(saved.path).mode & 0o600).toBe(0o600);
    }
    expect(readFileSync(saved.path, 'utf8')).toBe('hello spill');
  });

  it('writes distinct unpredictable files for repeated saves of the same name', async () => {
    const root = scratchDir();
    const first = await saveTextFile({ root, sessionId: 's', suggestedName: 'x', content: '1' });
    const second = await saveTextFile({ root, sessionId: 's', suggestedName: 'x', content: '2' });
    expect(first.path).not.toBe(second.path);
    expect(readFileSync(first.path, 'utf8')).toBe('1');
    expect(readFileSync(second.path, 'utf8')).toBe('2');
  });

  it('keeps session directories distinct', async () => {
    const root = scratchDir();
    const a = await saveTextFile({ root, sessionId: 'sess-a', suggestedName: 'x', content: 'a' });
    const b = await saveTextFile({ root, sessionId: 'sess-b', suggestedName: 'x', content: 'b' });
    expect(sessionDir(root, 'sess-a')).not.toBe(sessionDir(root, 'sess-b'));
    expect(readFileSync(a.path, 'utf8')).toBe('a');
    expect(readFileSync(b.path, 'utf8')).toBe('b');
  });
});

describe('SpillService', () => {
  it('round-trips save and read under a configured root', async () => {
    const root = scratchDir();
    const service = spillService(root);
    const ref = await service.saveText({
      owner: { sessionId: 'sess-1' },
      source: { toolName: 'bash', callId: 'c1', label: 'full-output' },
      suggestedName: 'bash-output.txt',
      content: 'complete output',
    });
    expect(ref.bytes).toBe(15);
    expect(ref.retrievalHint).toContain('bash-output.txt');
    expect(await service.readText(ref.locator)).toBe('complete output');
  });

  it('uses the private root when no [spill] root is configured', async () => {
    const service = spillService(undefined);
    const ref = await service.saveText({
      owner: { sessionId: 's' },
      source: { toolName: 'bash', callId: 'c', label: 'l' },
      suggestedName: 'x.txt',
      content: 'y',
    });
    expect(await readFile(ref.locator, 'utf8')).toBe('y');
  });

  it('refuses to read a locator outside the configured root', async () => {
    const root = scratchDir();
    const service = spillService(root);
    expect(await service.readText(SpillLocator('C:\\Windows\\win.ini'))).toBeNull();
    expect(await service.readText(SpillLocator(join(root, '..', 'outside.txt')))).toBeNull();
  });

    it('refuses to read through a symlink that escapes the root', async () => {
      const root = scratchDir();
      const outsideDir = scratchDir();
      const outside = join(outsideDir, 'secret.txt');
      await writeFile(outside, 'secret', 'utf8');
      const link = join(root, 'escape.txt');
      try {
        await symlink(outside, link);
      } catch {
        return;
      }
      const service = spillService(root);
      expect(await service.readText(SpillLocator(link))).toBeNull();
    });


  it('reads a missing artifact as null', async () => {
    const root = scratchDir();
    const service = spillService(root);
    const ref = await service.saveText({
      owner: { sessionId: 's' },
      source: { toolName: 'bash', callId: 'c', label: 'l' },
      suggestedName: 'x.txt',
      content: 'y',
    });
    const gone = SpillLocator(ref.locator.replace(/[a-f0-9]{12}-/, 'deadbeefcafe-'));
    expect(await service.readText(gone)).toBeNull();
  });
});

describe('ISpillService brand', () => {
  it('is a decorator identifier usable for DI', () => {
    const service: ISpillService = spillService(undefined);
    expect(service).toBeDefined();
    expect(SpillLocator('x')).toBe('x');
  });
});
