import { describe, expect, it } from 'bun:test';

import { resolvePluginNodeRunner } from '#/cli/plugin-node-runner';

describe('resolvePluginNodeRunner', () => {
  it('runs the binary directly when embedded assets mark a packaged build', () => {
    expect(
      resolvePluginNodeRunner({
        execPath: 'kimi.exe',
        argv: ['kimi.exe', 'web'],
        execArgv: [],
        assets: { probe: 'present' },
      }),
    ).toEqual({ command: 'kimi.exe', args: ['__plugin_run_node'] });
  });

  it('keeps the dev launcher prefix so the hidden subcommand reaches main.ts', () => {
    expect(
      resolvePluginNodeRunner({
        execPath: 'bun.exe',
        argv: ['bun.exe', 'D:/app/apps/kimi-code/src/main.ts', 'web'],
        execArgv: ['--import', 'D:/app/build/register-raw-text-loader.mjs'],
        assets: {},
      }),
    ).toEqual({
      command: 'bun.exe',
      args: [
        '--import',
        'D:/app/build/register-raw-text-loader.mjs',
        'D:/app/apps/kimi-code/src/main.ts',
        '__plugin_run_node',
      ],
    });
  });

  it('returns undefined when the process is neither packaged nor running the CLI entry', () => {
    expect(
      resolvePluginNodeRunner({
        execPath: 'bun.exe',
        argv: ['bun.exe', 'web'],
        execArgv: [],
        assets: {},
      }),
    ).toBeUndefined();
  });
});
