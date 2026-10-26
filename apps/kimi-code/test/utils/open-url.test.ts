import { describe, expect, it, mock } from 'bun:test';

import { openUrl, type OpenUrlDeps } from '#/utils/open-url';

const url = 'kimi-code://open?root=%2Ftmp%2Fa%25NAME%25%26b&new=1';

function fakeChild(exited: Promise<number> = Promise.resolve(0)) {
  return { exited };
}

type SpawnCall = [
  argv: string[],
  options: { windowsHide: boolean; stdio: ['ignore', 'ignore', 'ignore'] },
];

describe('openUrl', () => {
  const platformCases: Array<[NodeJS.Platform, string]> = [
    ['darwin', 'open'],
    ['linux', 'xdg-open'],
  ];

  it.each(platformCases)(
    'opens URLs as one argument on %s using an absolute executable',
    (platform, command) => {
      const spawn = mock(() => fakeChild());
      const resolveCommandPath = mock((name: string) => `/system/${name}`);

      openUrl(url, undefined, { platform, spawn, resolveCommandPath });

      expect(resolveCommandPath).toHaveBeenCalledWith(command);
      expect(spawn).toHaveBeenCalledWith(['/system/' + command, url], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    },
  );

  it('reports a missing opener without spawning a bare command', () => {
    const spawn = mock(() => fakeChild());
    const onError = mock();

    openUrl(url, onError, {
      platform: 'linux',
      spawn,
      resolveCommandPath: () => undefined,
    });

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports OS opener failures', async () => {
    const error = new Error('no scheme handler');
    const spawn = mock(() => fakeChild(Promise.reject(error)));
    const onError = mock();

    openUrl(url, onError, {
      platform: 'linux',
      spawn,
      resolveCommandPath: () => '/system/open',
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('uses a failure-reporting Windows opener and quotes URLs as literal strings', () => {
    const spawn = mock(() => fakeChild());
    const windowsUrl = "kimi-code://open?root=C%3A%5Ctest's%26%25&new=1";

    openUrl(windowsUrl, undefined, {
      platform: 'win32',
      spawn,
      resolveCommandPath: (name) => `/system/${name}`,
    });

    const calls = spawn.mock.calls as unknown as SpawnCall[];
    const call = calls[0]!;
    const argv = call[0];
    expect(argv[0]).toBe('/system/powershell.exe');
    expect(argv.slice(1, 4)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(Buffer.from(argv[4]!, 'base64').toString('utf16le')).toBe(
      "try { Start-Process -FilePath 'kimi-code://open?root=C%3A%5Ctest''s%26%25&new=1' -ErrorAction Stop } catch { exit 1 }",
    );
    expect(call[1]).toEqual({ windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  });
});
