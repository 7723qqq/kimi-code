import type { FetchLike } from '#/_base/utils/fetchLike';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { CapabilityEntryContext } from '#/app/capability/entries/context';
import {
  createKimiCuEntry,
  elevatedSwapScript,
  parsePermissionStatus,
  parseWindowsDoctorOutput,
  readAppBundleVersion,
  windowsPowerShellPath,
  windowsPowerShell7Path,
} from '#/app/capability/entries/kimiCu';
import type { IPluginService } from '#/app/plugin/plugin';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

function fakeProc(code: number, stdout = '', stderr = ''): IHostProcess {
  return {
    _serviceBrand: undefined,
    pid: 1234,
    exitCode: code,
    stdin: new Writable({
      write: (_c, _e, cb) => {
        cb();
      },
    }),
    stdout: Readable.from([stdout]),
    stderr: Readable.from([stderr]),
    wait: () => Promise.resolve(code),
    kill: () => Promise.resolve(),
    dispose: () => {},
  } as IHostProcess;
}

function fakeHostProcess(
  script: Array<{ match: string; code: number; stdout?: string; stderr?: string; hang?: boolean }>,
): { service: IHostProcessService; calls: string[] } {
  const calls: string[] = [];
  const service: IHostProcessService = {
    _serviceBrand: undefined,
    spawn: (command: string, args: readonly string[] = []) => {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      const hit = script.find((s) => key.includes(s.match));
      if (hit?.hang === true) {
        return Promise.resolve({
          _serviceBrand: undefined,
          pid: 1234,
          exitCode: null,
          stdin: new Writable({
            write: (_c, _e, cb) => {
              cb();
            },
          }),
          stdout: Readable.from(['']),
          stderr: Readable.from(['']),
          wait: () => new Promise<number>(() => {}),
          kill: () => Promise.resolve(),
          dispose: () => {},
        } as IHostProcess);
      }
      return Promise.resolve(fakeProc(hit?.code ?? 0, hit?.stdout ?? '', hit?.stderr ?? ''));
    },
  } as IHostProcessService;
  return { service, calls };
}

function fakePlugins(
  installed: Array<{
    id: string;
    enabled: boolean;
    state: string;
    version?: string;
    enabledMcp?: number;
  }>,
  onInstall?: () => void | Promise<void>,
): {
  service: IPluginService;
  installs: string[];
  enabledCalls: Array<{ id: string; enabled: boolean }>;
  mcpEnabledCalls: Array<{ id: string; server: string; enabled: boolean }>;
} {
  const installs: string[] = [];
  const enabledCalls: Array<{ id: string; enabled: boolean }> = [];
  const mcpEnabledCalls: Array<{ id: string; server: string; enabled: boolean }> = [];
  const service = {
    listPlugins: () =>
      Promise.resolve(
        installed.map((p) => ({
          id: p.id,
          displayName: p.id,
          version: p.version,
          enabled: p.enabled,
          state: p.state,
          skillCount: 1,
          mcpServerCount: 1,
          enabledMcpServerCount: p.enabledMcp ?? 1,
          hookCount: 0,
          commandCount: 0,
          hasErrors: false,
          source: 'zip-url',
        })),
      ),
    getPluginInfo: (input: { id: string }) => {
      const existing = installed.find((p) => p.id === input.id);
      return Promise.resolve({
        mcpServers: [
          {
            name: input.id === 'kimi-cu-win' ? 'win' : 'mac',
            runtimeName: input.id === 'kimi-cu-win' ? 'win' : 'mac',
            enabled: (existing?.enabledMcp ?? 1) === 1,
            transport: 'stdio',
          },
        ],
      } as never);
    },
    installPlugin: async (input: { source: string }) => {
      installs.push(input.source);
      await onInstall?.();
      const id = input.source.includes('computer-use-windows') ? 'kimi-cu-win' : 'kimi-cu';
      const existing = installed.find((p) => p.id === id);
      if (existing === undefined) {
        installed.push({ id, enabled: true, state: 'ok' });
        return { enabled: true, mcpServerCount: 1, enabledMcpServerCount: 1 } as never;
      }
      existing.state = 'ok';
      return {
        enabled: existing.enabled,
        mcpServerCount: 1,
        enabledMcpServerCount: existing.enabledMcp ?? 1,
      } as never;
    },
    setPluginEnabled: (input: { id: string; enabled: boolean }) => {
      enabledCalls.push(input);
      const existing = installed.find((p) => p.id === input.id);
      if (existing !== undefined) existing.enabled = input.enabled;
      return Promise.resolve();
    },
    setPluginMcpServerEnabled: (input: { id: string; server: string; enabled: boolean }) => {
      mcpEnabledCalls.push(input);
      const existing = installed.find((p) => p.id === input.id);
      if (existing !== undefined) existing.enabledMcp = input.enabled ? 1 : 0;
      return Promise.resolve();
    },
  } as unknown as IPluginService;
  return { service, installs, enabledCalls, mcpEnabledCalls };
}

describe('parsePermissionStatus', () => {
  it('parses the machine-readable request-permissions output', () => {
    expect(parsePermissionStatus('permissions: accessibility=true screenRecording=true')).toEqual({
      accessibility: true,
      screenRecording: true,
    });
    expect(parsePermissionStatus('permissions: accessibility=true screenRecording=false')).toEqual({
      accessibility: true,
      screenRecording: false,
    });
    expect(
      parsePermissionStatus('permissionStatus: accessibility=false screenRecording=true'),
    ).toEqual({
      accessibility: false,
      screenRecording: true,
    });
    expect(parsePermissionStatus('unknown command')).toBeUndefined();
    expect(parsePermissionStatus('')).toBeUndefined();
  });
});

describe('parseWindowsDoctorOutput', () => {
  it('accepts only an MCP-capable embedded runtime', () => {
    expect(
      parseWindowsDoctorOutput(
        'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n',
      ),
    ).toEqual({ version: '0.2.14' });
    expect(parseWindowsDoctorOutput('mcp=false\nhelper=embedded')).toBeUndefined();
    expect(parseWindowsDoctorOutput('mcp=true\nhelper=external')).toBeUndefined();
  });
});

describe('windowsPowerShellPath', () => {
  it('always resolves the system Windows PowerShell executable absolutely', () => {
    expect(windowsPowerShellPath('D:\\Windows')).toBe(
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(path.win32.isAbsolute(windowsPowerShellPath('relative'))).toBe(true);
    expect(windowsPowerShell7Path('D:\\Program Files')).toBe(
      'D:\\Program Files\\PowerShell\\7\\pwsh.exe',
    );
    expect(path.win32.isAbsolute(windowsPowerShell7Path('relative'))).toBe(true);
  });
});

describe('elevatedSwapScript', () => {
  it('swaps the staged bundle in under one shell-quoted transaction', () => {
    expect(
      elevatedSwapScript('/tmp/kimi cu/app', '/Applications/KimiCU.app', '/Applications/x.new-1-2'),
    ).toBe(
      "set -e; rm -rf '/Applications/KimiCU.app.bak'; rm -rf '/Applications/x.new-1-2'; " +
        "/usr/bin/ditto '/tmp/kimi cu/app' '/Applications/x.new-1-2'; " +
        "if [ -e '/Applications/KimiCU.app' ]; then /bin/mv '/Applications/KimiCU.app' '/Applications/KimiCU.app.bak'; fi; " +
        "if ! /bin/mv '/Applications/x.new-1-2' '/Applications/KimiCU.app'; then " +
        "if [ -e '/Applications/KimiCU.app.bak' ]; then /bin/mv '/Applications/KimiCU.app.bak' '/Applications/KimiCU.app'; fi; " +
        'exit 1; fi; ' +
        "rm -rf '/Applications/KimiCU.app.bak'",
    );
  });

  it('shell-quotes every path so spaces and metacharacters stay literal', () => {
    const script = elevatedSwapScript(
      "$(touch /tmp/pwned); echo '",
      '/Applications/KimiCU.app',
      '/Applications/KimiCU.app.new-x',
    );
    expect(script).toContain("/usr/bin/ditto '$(touch /tmp/pwned); echo '\\'''");
    expect(script).not.toContain('ditto $(touch');
  });
});

describe('readAppBundleVersion', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kimi-cu-version-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads CFBundleShortVersionString from Info.plist', async () => {
    const plist = path.join(root, 'Info.plist');
    await writeFile(
      plist,
      `<?xml version="1.0"?><plist><dict>
<key>CFBundleShortVersionString</key>
<string>0.4.18</string>
</dict></plist>`,
    );
    expect(await readAppBundleVersion(plist)).toBe('0.4.18');
  });

  it('returns undefined for a missing file', async () => {
    expect(await readAppBundleVersion(path.join(root, 'nope.plist'))).toBeUndefined();
  });
});

describe('kimi-cu entry', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kimi-cu-entry-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function fakeAppBundle(): Promise<string> {
    const applicationsDir = path.join(root, 'Applications');
    const macosDir = path.join(applicationsDir, 'KimiCU.app', 'Contents', 'MacOS');
    await mkdir(macosDir, { recursive: true });
    const appBin = path.join(macosDir, 'kimi-cu');
    await writeFile(appBin, '#!/bin/sh\n');
    await chmod(appBin, 0o755);
    await writeFile(
      path.join(applicationsDir, 'KimiCU.app', 'Contents', 'Info.plist'),
      '<key>CFBundleShortVersionString</key>\n<string>0.5.4</string>',
    );
    return applicationsDir;
  }

  function makeCtx(overrides: Partial<CapabilityEntryContext> = {}): CapabilityEntryContext {
    return {
      platform: 'darwin',
      arch: 'arm64',
      kimiHomeDir: path.join(root, 'kimi-home'),
      userHomeDir: path.join(root, 'user-home'),
      plugins: fakePlugins([]).service,
      hostProcess: fakeHostProcess([]).service,
      ...overrides,
    };
  }

  it('supports macOS and Windows x64 under one capability id', () => {
    expect(createKimiCuEntry(makeCtx()).supported).toBe(true);
    expect(createKimiCuEntry(makeCtx({ platform: 'linux' })).supported).toBe(false);
    expect(createKimiCuEntry(makeCtx({ platform: 'win32', arch: 'x64' }))).toMatchObject({
      id: 'kimi-cu',
      pluginId: 'kimi-cu-win',
      supported: true,
    });
    expect(createKimiCuEntry(makeCtx({ platform: 'win32', arch: 'arm64' })).supported).toBe(false);
  });

  it('labels the Windows capability consistently with its installed plugin', () => {
    expect(createKimiCuEntry(makeCtx({ platform: 'win32', arch: 'x64' })).displayName).toBe(
      'Kimi Computer Use for Windows',
    );
  });

  it('detects the Windows plugin and signed runtime through doctor', async () => {
    const plugins = fakePlugins([
      { id: 'kimi-cu-win', enabled: true, state: 'ok', version: '0.2.14' },
    ]);
    const host = fakeHostProcess([
      {
        match: '-Command',
        code: 0,
        stdout: 'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess: host.service,
      }),
    );

    await expect(entry.detect()).resolves.toEqual({
      version: '0.2.14',
      steps: [
        { id: 'plugin', state: 'ok', detail: '0.2.14' },
        { id: 'runtime', state: 'ok', detail: '0.2.14' },
      ],
    });
    expect(host.calls).toHaveLength(1);
    expect(
      host.calls[0]?.startsWith(`${windowsPowerShellPath()} -NoProfile -NonInteractive -Command `),
    ).toBe(true);
  });

  it('installs Windows with the official setup script and shared plugin wiring', async () => {
    const plugins = fakePlugins([]);
    const calls: string[] = [];
    const doctorResults = [
      { code: 3, stdout: '', stderr: '' },
      {
        code: 0,
        stdout: 'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n',
        stderr: '',
      },
    ];
    const hostProcess = {
      _serviceBrand: undefined,
      spawn: (command: string, args: readonly string[] = []) => {
        calls.push(`${command} ${args.join(' ')}`);
        if (args.some((arg) => arg.includes('Get-FileHash'))) {
          return Promise.resolve(fakeProc(0, 'PowerShell 5.1'));
        }
        if (args.some((arg) => arg.includes('setup_windows.ps1'))) {
          return Promise.resolve(fakeProc(0));
        }
        if (args.includes('-Command')) {
          const result = doctorResults.shift();
          return Promise.resolve(
            fakeProc(
              result?.code ?? 1,
              result?.stdout ?? '',
              result?.stderr ?? 'unexpected doctor',
            ),
          );
        }
        return Promise.resolve(fakeProc(1));
      },
    } as IHostProcessService;
    const fetchImpl = (() => {
      const bytes = new TextEncoder().encode("Write-Host 'official setup'");
      return Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        }),
      );
    }) as FetchLike;
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess,
        fetchImpl,
      }),
    );
    const reports: Array<[string, number | undefined]> = [];

    await entry.install((step, percent) => reports.push([step, percent]));

    expect(plugins.installs).toEqual([
      'https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip',
    ]);
    expect(reports).toContainEqual(['plugin', undefined]);
    expect(reports).toContainEqual(['download', 0]);
    expect(reports).toContainEqual(['download', 100]);
    expect(reports).toContainEqual(['runtime', undefined]);
    expect(
      calls.some(
        (call) =>
          call.includes('-ExecutionPolicy Bypass -Command') &&
          call.includes('[Console]::OutputEncoding = $utf8') &&
          call.includes('setup_windows.ps1'),
      ),
    ).toBe(true);
    expect(calls.every((call) => call.startsWith(windowsPowerShellPath()))).toBe(true);
    expect(doctorResults).toEqual([]);
  });

  it('rejects a Windows setup download whose published checksum does not match', async () => {
    const plugins = fakePlugins([]);
    const calls: string[] = [];
    const hostProcess = {
      _serviceBrand: undefined,
      spawn: (command: string, args: readonly string[] = []) => {
        calls.push(`${command} ${args.join(' ')}`);
        if (args.some((arg) => arg.includes('Get-FileHash'))) {
          return Promise.resolve(fakeProc(0, 'PowerShell 5.1'));
        }
        return Promise.resolve(fakeProc(0));
      },
    } as IHostProcessService;
    const fetchImpl = ((url: string) => {
      if (url.endsWith('.sha256')) {
        const bytes = new TextEncoder().encode('0'.repeat(64));
        return Promise.resolve(
          new Response(bytes, { status: 200, headers: { 'content-length': '64' } }),
        );
      }
      const bytes = new TextEncoder().encode("Write-Host 'official setup'");
      return Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        }),
      );
    }) as FetchLike;
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess,
        fetchImpl,
      }),
    );

    await expect(entry.install(() => {})).rejects.toThrow(/Checksum mismatch/);
    expect(calls.some((call) => call.includes('setup_windows.ps1'))).toBe(false);
  });

  it('uses trusted PowerShell 7 when system PowerShell cannot run the installer', async () => {
    const plugins = fakePlugins([]);
    const calls: string[] = [];
    const doctorResults = [
      { code: 3, stdout: '', stderr: '' },
      {
        code: 0,
        stdout: 'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n',
        stderr: '',
      },
    ];
    const hostProcess = {
      _serviceBrand: undefined,
      spawn: (command: string, args: readonly string[] = []) => {
        calls.push(`${command} ${args.join(' ')}`);
        if (args.some((arg) => arg.includes('Get-FileHash'))) {
          return Promise.resolve(
            command === windowsPowerShellPath()
              ? fakeProc(2, '', 'missing commands: Get-FileHash')
              : fakeProc(0, 'PowerShell 7.5.2'),
          );
        }
        if (args.some((arg) => arg.includes('setup_windows.ps1'))) {
          return Promise.resolve(fakeProc(0));
        }
        const result = doctorResults.shift();
        return Promise.resolve(
          fakeProc(result?.code ?? 1, result?.stdout ?? '', result?.stderr ?? 'unexpected doctor'),
        );
      },
    } as IHostProcessService;
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess,
        fetchImpl: (() =>
          Promise.resolve(
            new Response("Write-Host 'official setup'", {
              headers: { 'content-length': '27' },
            }),
          )) as FetchLike,
      }),
    );

    await entry.install(() => {});

    expect(
      calls.some(
        (call) => call.startsWith(windowsPowerShell7Path()) && call.includes('setup_windows.ps1'),
      ),
    ).toBe(true);
    expect(plugins.installs).toEqual([
      'https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip',
    ]);
  });

  it('keeps the Windows runtime detectable after installing through PowerShell 7', async () => {
    const plugins = fakePlugins([]);
    const calls: string[] = [];
    let runtimeInstalled = false;
    const hostProcess = {
      _serviceBrand: undefined,
      spawn: (command: string, args: readonly string[] = []) => {
        calls.push(`${command} ${args.join(' ')}`);
        if (command === windowsPowerShellPath()) {
          return Promise.reject(new Error('Windows PowerShell cannot launch'));
        }
        if (args.some((arg) => arg.includes('Get-FileHash'))) {
          return Promise.resolve(fakeProc(0, 'PowerShell 7.5.2'));
        }
        if (args.some((arg) => arg.includes('setup_windows.ps1'))) {
          runtimeInstalled = true;
          return Promise.resolve(fakeProc(0));
        }
        return Promise.resolve(
          runtimeInstalled
            ? fakeProc(0, 'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n')
            : fakeProc(3),
        );
      },
    } as IHostProcessService;
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess,
        fetchImpl: (() =>
          Promise.resolve(
            new Response("Write-Host 'official setup'", {
              headers: { 'content-length': '27' },
            }),
          )) as FetchLike,
      }),
    );

    await entry.install(() => {});

    await expect(entry.detect()).resolves.toEqual({
      version: '0.2.14',
      steps: [
        { id: 'plugin', state: 'ok' },
        { id: 'runtime', state: 'ok', detail: '0.2.14' },
      ],
    });
    expect(
      calls.some(
        (call) => call.startsWith(windowsPowerShell7Path()) && call.includes('setup_windows.ps1'),
      ),
    ).toBe(true);
  });

  it('leaves plugin wiring untouched when no PowerShell can run the installer', async () => {
    const plugins = fakePlugins([]);
    let downloads = 0;
    const hostProcess = {
      _serviceBrand: undefined,
      spawn: (command: string, args: readonly string[] = []) => {
        if (args.some((arg) => arg.includes('Get-FileHash'))) {
          return Promise.resolve(
            fakeProc(2, '', `${command}: missing commands: Get-FileHash, Expand-Archive`),
          );
        }
        return Promise.resolve(fakeProc(3));
      },
    } as IHostProcessService;
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess,
        fetchImpl: (() => {
          downloads += 1;
          return Promise.reject(new Error('download should not start'));
        }) as FetchLike,
      }),
    );

    await expect(entry.install(() => {})).rejects.toThrow(
      /requires Windows PowerShell 5\.1 or PowerShell 7.*Get-FileHash, Expand-Archive/,
    );

    expect(plugins.installs).toEqual([]);
    expect(downloads).toBe(0);
  });

  it('repairs a missing Windows runtime without replacing a healthy plugin', async () => {
    const plugins = fakePlugins([{ id: 'kimi-cu-win', enabled: true, state: 'ok' }]);
    const doctorResults = [
      { code: 3, stdout: '', stderr: '' },
      {
        code: 0,
        stdout: 'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n',
        stderr: '',
      },
    ];
    const hostProcess = {
      _serviceBrand: undefined,
      spawn: (_command: string, args: readonly string[] = []) => {
        if (args.some((arg) => arg.includes('Get-FileHash'))) {
          return Promise.resolve(fakeProc(0, 'PowerShell 5.1'));
        }
        if (args.some((arg) => arg.includes('setup_windows.ps1'))) {
          return Promise.resolve(fakeProc(0));
        }
        const result = doctorResults.shift();
        return Promise.resolve(
          fakeProc(result?.code ?? 1, result?.stdout ?? '', result?.stderr ?? 'unexpected doctor'),
        );
      },
    } as IHostProcessService;
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess,
        fetchImpl: (() =>
          Promise.resolve(
            new Response("Write-Host 'official setup'", {
              headers: { 'content-length': '27' },
            }),
          )) as FetchLike,
      }),
    );

    await entry.install(() => {});

    expect(plugins.installs).toEqual([]);
    expect(doctorResults).toEqual([]);
  });

  it('refreshes the Windows plugin when installation starts fully ready', async () => {
    const plugins = fakePlugins([{ id: 'kimi-cu-win', enabled: true, state: 'ok' }]);
    const doctorResults = [
      {
        code: 0,
        stdout: 'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n',
        stderr: '',
      },
      {
        code: 0,
        stdout: 'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n',
        stderr: '',
      },
    ];
    const hostProcess = {
      _serviceBrand: undefined,
      spawn: (_command: string, args: readonly string[] = []) => {
        if (args.some((arg) => arg.includes('Get-FileHash'))) {
          return Promise.resolve(fakeProc(0, 'PowerShell 5.1'));
        }
        if (args.some((arg) => arg.includes('setup_windows.ps1'))) {
          return Promise.resolve(fakeProc(0));
        }
        const result = doctorResults.shift();
        return Promise.resolve(
          fakeProc(result?.code ?? 1, result?.stdout ?? '', result?.stderr ?? 'unexpected doctor'),
        );
      },
    } as IHostProcessService;
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess,
        fetchImpl: (() =>
          Promise.resolve(
            new Response("Write-Host 'official setup'", {
              headers: { 'content-length': '27' },
            }),
          )) as FetchLike,
      }),
    );

    await entry.install(() => {});

    expect(plugins.installs).toEqual([
      'https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip',
    ]);
    expect(doctorResults).toEqual([]);
  });

  it('explains how to recover when Windows plugin files are still in use', async () => {
    const busy = Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    const plugins = fakePlugins([], () => {
      throw busy;
    });
    const host = fakeHostProcess([
      {
        match: '-Command',
        code: 0,
        stdout: 'version=0.2.14\nmcp=true\nhelper=embedded\nagent=running\n',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess: host.service,
      }),
    );

    await expect(entry.install(() => {})).rejects.toThrow(
      'Kimi Computer Use plugin files are still in use by the current Kimi Code process. Restart Kimi Code, then install again.',
    );
  });

  it('does not reinstall a healthy Windows runtime when only the plugin is missing', async () => {
    const plugins = fakePlugins([]);
    const host = fakeHostProcess([
      {
        match: '-Command',
        code: 0,
        stdout: 'version=0.2.14\nmcp=true\nhelper=embedded\nagent=running\n',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess: host.service,
        fetchImpl: (() => Promise.reject(new Error('download should be skipped'))) as never,
      }),
    );
    const reports: string[] = [];

    await entry.install((step) => reports.push(step));

    expect(reports).toEqual(['plugin']);
    expect(host.calls).toHaveLength(1);
  });

  it('detects all four layers with details', async () => {
    const applicationsDir = await fakeAppBundle();
    const plugins = fakePlugins([{ id: 'kimi-cu', enabled: true, state: 'ok', version: '0.5.4' }]);
    const host = fakeHostProcess([
      {
        match: 'service-status',
        code: 0,
        stdout: 'SMAppService status=1 (1=enabled); fallback plist exists=false',
      },
      {
        match: 'xpc-ping',
        code: 0,
        stdout: 'permissionStatus: accessibility=true screenRecording=false',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({ applicationsDir, plugins: plugins.service, hostProcess: host.service }),
    );

    const detected = await entry.detect();
    expect(detected.version).toBe('0.5.4');
    expect(detected.steps).toEqual([
      { id: 'plugin', state: 'ok', detail: '0.5.4' },
      { id: 'app', state: 'ok', detail: '0.5.4' },
      { id: 'service', state: 'ok' },
      { id: 'permissions', state: 'missing', detail: 'screenRecording' },
    ]);
    expect(host.calls.some((call) => call.endsWith(' xpc-ping'))).toBe(true);
    expect(host.calls.some((call) => call.includes('request-permissions'))).toBe(false);
  });

  it('reports missing layers on a bare machine', async () => {
    const entry = createKimiCuEntry(makeCtx({ applicationsDir: path.join(root, 'Applications') }));
    const detected = await entry.detect();
    expect(detected.version).toBeUndefined();
    expect(detected.steps.map((s) => [s.id, s.state])).toEqual([
      ['plugin', 'missing'],
      ['app', 'missing'],
      ['service', 'missing'],
      ['permissions', 'missing'],
    ]);
  });

  it('rejects install on non-macOS before any side effect', async () => {
    const plugins = fakePlugins([]);
    const entry = createKimiCuEntry(makeCtx({ platform: 'linux', plugins: plugins.service }));
    await expect(entry.install(() => {})).rejects.toThrow(/only supported on macOS/);
    expect(plugins.installs).toEqual([]);
  });

  it('resumes a partial install without repeating completed runtime layers', async () => {
    const applicationsDir = await fakeAppBundle();
    const plugins = fakePlugins([]);
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      {
        match: 'xpc-ping',
        code: 0,
        stdout: 'permissionStatus: accessibility=true screenRecording=true',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir,
        plugins: plugins.service,
        hostProcess: host.service,
        fetchImpl: (() => Promise.reject(new Error('download should be skipped'))) as never,
      }),
    );
    const reports: string[] = [];

    await entry.install((step) => reports.push(step));

    expect(plugins.installs).toHaveLength(1);
    expect(reports).toEqual(['plugin']);
    expect(
      host.calls.every((call) => call.includes('service-status') || call.includes('xpc-ping')),
    ).toBe(true);
  });

  it('migrates the exact legacy standalone MCP registration after installing the plugin', async () => {
    const applicationsDir = await fakeAppBundle();
    const appBin = path.join(applicationsDir, 'KimiCU.app', 'Contents', 'MacOS', 'kimi-cu');
    const kimiHomeDir = path.join(root, 'kimi-home');
    await mkdir(kimiHomeDir, { recursive: true });
    await writeFile(
      path.join(kimiHomeDir, 'mcp.json'),
      `${JSON.stringify({
        mcpServers: {
          'kimi-cu': { command: appBin, args: ['mcp', '-s', 'user'] },
          custom: { command: 'custom-mcp', args: [] },
        },
      })}\n`,
    );
    const plugins = fakePlugins([]);
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      {
        match: 'xpc-ping',
        code: 0,
        stdout: 'permissionStatus: accessibility=true screenRecording=true',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir,
        kimiHomeDir,
        plugins: plugins.service,
        hostProcess: host.service,
      }),
    );

    expect((await entry.detect()).steps).toContainEqual({
      id: 'legacy-mcp',
      state: 'missing',
      detail: 'duplicate standalone kimi-cu MCP registration',
      optional: true,
    });
    const reports: string[] = [];
    await entry.install((step) => reports.push(step));

    const migrated = JSON.parse(await readFile(path.join(kimiHomeDir, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(migrated.mcpServers['kimi-cu']).toBeUndefined();
    expect(migrated.mcpServers['custom']).toEqual({ command: 'custom-mcp', args: [] });
    expect(reports).toEqual(['plugin', 'mcp-config']);
  });

  it('leaves the legacy MCP config untouched when it changes during setup', async () => {
    const applicationsDir = await fakeAppBundle();
    const appBin = path.join(applicationsDir, 'KimiCU.app', 'Contents', 'MacOS', 'kimi-cu');
    const kimiHomeDir = path.join(root, 'kimi-home');
    await mkdir(kimiHomeDir, { recursive: true });
    const configPath = path.join(kimiHomeDir, 'mcp.json');
    const legacy = { command: appBin, args: ['mcp', '-s', 'user'] };
    await writeFile(configPath, `${JSON.stringify({ mcpServers: { 'kimi-cu': legacy } })}\n`);
    const concurrentConfig = {
      mcpServers: {
        'kimi-cu': legacy,
        addedDuringSetup: { command: 'another-mcp', args: [] },
      },
    };
    const plugins = fakePlugins([], async () => {
      await writeFile(configPath, `${JSON.stringify(concurrentConfig, null, 2)}\n`);
    });
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      {
        match: 'xpc-ping',
        code: 0,
        stdout: 'permissionStatus: accessibility=true screenRecording=true',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir,
        kimiHomeDir,
        plugins: plugins.service,
        hostProcess: host.service,
      }),
    );
    const reports: string[] = [];

    await entry.install((step) => reports.push(step));

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(concurrentConfig);
    expect(reports).toEqual(['plugin']);
  });

  it('does not migrate a customized standalone MCP registration', async () => {
    const applicationsDir = await fakeAppBundle();
    const appBin = path.join(applicationsDir, 'KimiCU.app', 'Contents', 'MacOS', 'kimi-cu');
    const kimiHomeDir = path.join(root, 'kimi-home');
    await mkdir(kimiHomeDir, { recursive: true });
    const configPath = path.join(kimiHomeDir, 'mcp.json');
    const custom = {
      mcpServers: {
        'kimi-cu': { command: appBin, args: ['mcp', '-s', 'user'], env: { CUSTOM: '1' } },
      },
    };
    await writeFile(configPath, `${JSON.stringify(custom)}\n`);
    const plugins = fakePlugins([]);
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      {
        match: 'xpc-ping',
        code: 0,
        stdout: 'permissionStatus: accessibility=true screenRecording=true',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir,
        kimiHomeDir,
        plugins: plugins.service,
        hostProcess: host.service,
      }),
    );

    await entry.install(() => {});

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(custom);
  });

  it('marks probe steps failed instead of throwing when the binary is wedged', async () => {
    const applicationsDir = await fakeAppBundle();
    const plugins = fakePlugins([]);
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, hang: true },
      { match: 'xpc-ping', code: 0, hang: true },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir,
        plugins: plugins.service,
        hostProcess: host.service,
        detectProbeTimeoutMs: 5,
      }),
    );

    const detected = await entry.detect();
    expect(detected.steps.find((s) => s.id === 'service')).toEqual({
      id: 'service',
      state: 'failed',
      detail: expect.stringContaining('timed out'),
    });
    expect(detected.steps.find((s) => s.id === 'permissions')).toEqual({
      id: 'permissions',
      state: 'failed',
      detail: expect.stringContaining('timed out'),
    });

    await expect(entry.install(() => {})).rejects.toThrow(/not running after install/);
    expect(plugins.installs).toHaveLength(1);
  });

  it('re-enables a previously disabled wiring plugin during setup', async () => {
    const applicationsDir = await fakeAppBundle();
    const plugins = fakePlugins([{ id: 'kimi-cu', enabled: false, state: 'ok', version: '0.5.4' }]);
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      {
        match: 'xpc-ping',
        code: 0,
        stdout: 'permissionStatus: accessibility=true screenRecording=true',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({ applicationsDir, plugins: plugins.service, hostProcess: host.service }),
    );

    await entry.install(() => {});
    expect(plugins.enabledCalls).toEqual([{ id: 'kimi-cu', enabled: true }]);
  });

  it('refreshes the wiring plugin when permissions are the only missing layer', async () => {
    const applicationsDir = await fakeAppBundle();
    const plugins = fakePlugins([{ id: 'kimi-cu', enabled: true, state: 'ok', version: '0.5.4' }]);
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      {
        match: 'xpc-ping',
        code: 0,
        stdout: 'permissionStatus: accessibility=true screenRecording=false',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({ applicationsDir, plugins: plugins.service, hostProcess: host.service }),
    );

    await entry.install(() => {});

    expect(plugins.installs).toEqual([
      'https://cdn.kimi.com/kimi-computer-use/latest/kimi-cu-plugin.zip',
    ]);
  });

  it('continues the replacement when the old-binary cleanup hangs', async () => {
    const applicationsDir = await fakeAppBundle();
    const plugins = fakePlugins([{ id: 'kimi-cu', enabled: true, state: 'ok', version: '0.5.4' }]);
    const host = fakeHostProcess([
      { match: 'uninstall', code: 0, hang: true },
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      {
        match: 'xpc-ping',
        code: 0,
        stdout: 'permissionStatus: accessibility=true screenRecording=true',
      },
    ]);
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-length': '3' },
        }),
      )) as never;
    const appBin = path.join(applicationsDir, 'KimiCU.app', 'Contents', 'MacOS', 'kimi-cu');
    const hostProcess = {
      spawn: async (command: string, args: readonly string[] = []) => {
        const proc = await host.service.spawn(command, args);
        const destination = String(args.at(-1));
        if (
          command === 'ditto' &&
          (destination.includes('KimiCU.app') || args[0]?.includes('KimiCU.app'))
        ) {
          const stampedBin = destination.includes('KimiCU.app')
            ? path.join(destination, 'Contents', 'MacOS', 'kimi-cu')
            : appBin;
          await mkdir(path.dirname(stampedBin), { recursive: true });
          await writeFile(stampedBin, '#!/bin/sh\n');
          await chmod(stampedBin, 0o755);
        }
        return proc;
      },
    } as IHostProcessService;
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir,
        plugins: plugins.service,
        hostProcess,
        fetchImpl,
        commandTimeoutMs: 5,
      }),
    );

    await entry.install(() => {});
    expect(host.calls.some((call) => call.includes('ditto'))).toBe(true);
    expect(host.calls.some((call) => call.includes('pkill') && call.includes('+mcp'))).toBe(false);
    expect(host.calls.some((call) => call.includes('pkill') && call.includes('+service'))).toBe(
      true,
    );
  });

  it('reports the plugin layer missing when its MCP server is disabled', async () => {
    const plugins = fakePlugins([
      { id: 'kimi-cu', enabled: true, state: 'ok', version: '0.5.4', enabledMcp: 0 },
    ]);
    const entry = createKimiCuEntry(makeCtx({ plugins: plugins.service }));

    const detected = await entry.detect();
    expect(detected.steps.find((s) => s.id === 'plugin')).toEqual({
      id: 'plugin',
      state: 'missing',
      detail: 'mcp 0/1 enabled',
    });
  });

  it('re-enables disabled MCP servers during setup', async () => {
    const applicationsDir = await fakeAppBundle();
    const plugins = fakePlugins([
      { id: 'kimi-cu', enabled: true, state: 'ok', version: '0.5.4', enabledMcp: 0 },
    ]);
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      {
        match: 'xpc-ping',
        code: 0,
        stdout: 'permissionStatus: accessibility=true screenRecording=true',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({ applicationsDir, plugins: plugins.service, hostProcess: host.service }),
    );

    await entry.install(() => {});
    expect(plugins.mcpEnabledCalls).toEqual([{ id: 'kimi-cu', server: 'mac', enabled: true }]);
  });

  it('never stops the old service when the downloaded archive is corrupt', async () => {
    const plugins = fakePlugins([]);
    const host = fakeHostProcess([
      { match: 'ditto -x -k', code: 1, stderr: 'ditto: Not a zip file' },
    ]);
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(new TextEncoder().encode('<html>captive portal</html>'), {
          status: 200,
          headers: { 'content-length': '26' },
        }),
      )) as never;
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir: path.join(root, 'Applications'),
        plugins: plugins.service,
        hostProcess: host.service,
        fetchImpl,
      }),
    );

    await expect(entry.install(() => {})).rejects.toThrow(/Failed to unzip/);
    expect(host.calls.some((call) => call.includes('uninstall'))).toBe(false);
    expect(host.calls.some((call) => call.includes('bootout'))).toBe(false);
    expect(host.calls.some((call) => call.includes('pkill'))).toBe(false);
  });

  it('reads a bundle missing its Info.plist as a broken install', async () => {
    const applicationsDir = await fakeAppBundle();
    await rm(path.join(applicationsDir, 'KimiCU.app', 'Contents', 'Info.plist'));
    const entry = createKimiCuEntry(makeCtx({ applicationsDir }));

    const detected = await entry.detect();
    expect(detected.steps.find((s) => s.id === 'app')?.state).toBe('missing');
  });

  it('reads a non-executable leftover app binary as a broken install', async () => {
    const applicationsDir = await fakeAppBundle();
    await chmod(path.join(applicationsDir, 'KimiCU.app', 'Contents', 'MacOS', 'kimi-cu'), 0o644);
    const entry = createKimiCuEntry(makeCtx({ applicationsDir }));

    const detected = await entry.detect();
    if (process.platform === 'win32') {
      expect(detected.steps.find((s) => s.id === 'app')?.state).toBe('ok');
      return;
    }
    expect(detected.steps.find((s) => s.id === 'app')).toEqual({
      id: 'app',
      state: 'missing',
      detail: 'not executable',
    });
  });

  async function installableMacSetup(
    host: { service: IHostProcessService; calls: string[] },
    appBody: string,
  ): Promise<{ hostProcess: IHostProcessService }> {
    const placeBundle = async (source: string, target: string): Promise<void> => {
      await mkdir(path.join(target, 'Contents', 'MacOS'), { recursive: true });
      const sourceBin = path.join(source, 'Contents', 'MacOS', 'kimi-cu');
      const body = await readFile(sourceBin, 'utf8').catch(() => appBody);
      const bin = path.join(target, 'Contents', 'MacOS', 'kimi-cu');
      await writeFile(bin, body);
      await chmod(bin, 0o755);
      await writeFile(
        path.join(target, 'Contents', 'Info.plist'),
        '<key>CFBundleShortVersionString</key>\n<string>0.5.5</string>',
      );
    };
    const hostProcess = {
      spawn: async (command: string, args: readonly string[] = []) => {
        const proc = await host.service.spawn(command, args);
        const destination = String(args.at(-1));
        const source = String(args[0]);
        if (command === 'ditto') {
          const from = args[0] === '-x' ? String(args[2]) : source;
          if (args[0] === '-x') {
            await placeBundle(path.join(from, 'KimiCU.app'), path.join(destination, 'KimiCU.app'));
          } else if (destination.includes('KimiCU.app')) {
            await placeBundle(from, destination);
          }
        }
        return proc;
      },
    } as IHostProcessService;
    return { hostProcess };
  }

  const macFetchImpl = (() =>
    Promise.resolve(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-length': '3' },
      }),
    )) as never;

  it('keeps the installed app when the staged copy cannot be made', async () => {
    const applicationsDir = await fakeAppBundle();
    const appBin = path.join(applicationsDir, 'KimiCU.app', 'Contents', 'MacOS', 'kimi-cu');
    const plugins = fakePlugins([{ id: 'kimi-cu', enabled: true, state: 'ok', version: '0.5.4' }]);
    const host = fakeHostProcess([
      { match: 'ditto -x -k', code: 0 },
      { match: 'ditto', code: 1, stderr: 'ditto: Copy failed' },
      { match: 'osascript', code: 1, stderr: 'User canceled.' },
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      {
        match: 'xpc-ping',
        code: 0,
        stdout: 'permissionStatus: accessibility=true screenRecording=true',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir,
        plugins: plugins.service,
        hostProcess: host.service,
        fetchImpl: macFetchImpl,
      }),
    );

    await expect(entry.install(() => {})).rejects.toThrow(/Failed to install KimiCU\.app/);
    expect(await readFile(appBin, 'utf8')).toBe('#!/bin/sh\n');
    expect(host.calls.some((call) => call.includes('uninstall'))).toBe(false);
  });

  it('restores the installed app when the staged swap fails', async () => {
    const applicationsDir = await fakeAppBundle();
    const plugins = fakePlugins([{ id: 'kimi-cu', enabled: true, state: 'ok', version: '0.5.4' }]);
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      {
        match: 'xpc-ping',
        code: 0,
        stdout: 'permissionStatus: accessibility=true screenRecording=true',
      },
    ]);
    const { hostProcess } = await installableMacSetup(host, '#!/bin/sh\n');
    const offendingHost = {
      spawn: async (command: string, args: readonly string[] = []) => {
        const proc = await hostProcess.spawn(command, args);
        if (command === 'ditto' && String(args.at(-1)).includes('.new-')) {
          await rm(String(args.at(-1)), { recursive: true, force: true });
        }
        return proc;
      },
    } as IHostProcessService;
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir,
        plugins: plugins.service,
        hostProcess: offendingHost,
        fetchImpl: macFetchImpl,
      }),
    );

    await expect(entry.install(() => {})).rejects.toThrow(/staged bundle could not replace/);
    expect(await readdir(applicationsDir)).toEqual(['KimiCU.app']);
    const infoPlist = path.join(applicationsDir, 'KimiCU.app', 'Contents', 'Info.plist');
    expect(await readAppBundleVersion(infoPlist)).toBe('0.5.4');
  });

  it('replaces the installed app and leaves no staging entries after a successful install', async () => {
    const applicationsDir = await fakeAppBundle();
    await mkdir(path.join(applicationsDir, 'KimiCU.app.bak-1-1'), { recursive: true });
    await mkdir(path.join(applicationsDir, 'KimiCU.app.new-1-1'), { recursive: true });
    await mkdir(path.join(applicationsDir, 'KimiCU.app.bak'), { recursive: true });
    const plugins = fakePlugins([{ id: 'kimi-cu', enabled: true, state: 'ok', version: '0.5.4' }]);
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      {
        match: 'xpc-ping',
        code: 0,
        stdout: 'permissionStatus: accessibility=true screenRecording=true',
      },
    ]);
    const { hostProcess } = await installableMacSetup(host, '#!/bin/sh\necho new\n');
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir,
        plugins: plugins.service,
        hostProcess,
        fetchImpl: macFetchImpl,
      }),
    );

    await entry.install(() => {});

    const infoPlist = path.join(applicationsDir, 'KimiCU.app', 'Contents', 'Info.plist');
    expect(await readAppBundleVersion(infoPlist)).toBe('0.5.5');
    const leftovers = await readdir(applicationsDir);
    expect(leftovers.filter((entry) => /^KimiCU\.app\.(new|bak)-/.test(entry))).toEqual([]);
    expect(host.calls.some((call) => call.includes('xattr -dr com.apple.quarantine'))).toBe(true);
  });
});
