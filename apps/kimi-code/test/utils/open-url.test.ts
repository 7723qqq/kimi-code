import { describe, expect, it, mock } from 'bun:test';

import { openUrl } from '#/utils/open-url';

const url = 'kimi-code://open?root=%2Ftmp%2Fa%25NAME%25%26b&new=1';

describe('openUrl', () => {
  const platformCases: Array<[NodeJS.Platform, string]> = [
    ['darwin', 'open'],
    ['linux', 'xdg-open'],
  ];

  it.each(platformCases)(
    'opens URLs as one argument on %s using an absolute executable',
    (platform, command) => {
      const execFile = mock();
      const resolveCommandPath = mock((name: string) => `/system/${name}`);

      openUrl(url, undefined, { platform, execFile, resolveCommandPath });

      expect(resolveCommandPath).toHaveBeenCalledWith(command);
      expect(execFile).toHaveBeenCalledWith(
        `/system/${command}`,
        [url],
        { windowsHide: true },
        expect.any(Function),
      );
    },
  );

  it('reports a missing opener without spawning a bare command', () => {
    const execFile = mock();
    const onError = mock();

    openUrl(url, onError, {
      platform: 'linux',
      execFile,
      resolveCommandPath: () => undefined,
    });

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reports OS opener failures', () => {
    const execFile = mock();
    const onError = mock();

    openUrl(url, onError, {
      platform: 'linux',
      execFile,
      resolveCommandPath: () => '/system/open',
    });

    const callback = execFile.mock.calls[0]![3] as (error: Error) => void;
    const error = new Error('no scheme handler');
    callback(error);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('uses a failure-reporting Windows opener and quotes URLs as literal strings', () => {
    const execFile = mock();
    const windowsUrl = "kimi-code://open?root=C%3A%5Ctest's%26%25&new=1";

    openUrl(windowsUrl, undefined, {
      platform: 'win32',
      execFile,
      resolveCommandPath: (name) => `/system/${name}`,
    });

    const call = execFile.mock.calls[0]!;
    expect(call[0]).toBe('/system/powershell.exe');
    const args = call[1] as string[];
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(Buffer.from(args[3]!, 'base64').toString('utf16le')).toBe(
      "try { Start-Process -FilePath 'kimi-code://open?root=C%3A%5Ctest''s%26%25&new=1' -ErrorAction Stop } catch { exit 1 }",
    );
    expect(call[2]).toEqual({ windowsHide: true });
  });
});
