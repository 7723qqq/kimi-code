import { Command } from 'commander';
import { describe, expect, it, mock } from 'bun:test';

import type { KimiRegionProfile } from '@moonshot-ai/kimi-code-oauth';

import * as regionModule from '#/utils/region';
import { registerInstallDesktopCommand } from '#/cli/sub/install-desktop';

const mocks = (() => ({
  currentKimiProfile: mock(() => ({ siteBase: 'https://example.com' }) as unknown as KimiRegionProfile),
}))();

void mock.module('#/utils/region', () => ({ ...regionModule, currentKimiProfile: mocks.currentKimiProfile }));

type Write = Pick<NodeJS.WriteStream, 'write'>;

function createProgram() {
  const written = mock(() => true);
  const openUrl = mock();
  const program = new Command('kimi');
  registerInstallDesktopCommand(program, {
    stdout: { write: written } as unknown as Write,
    openUrl,
  });
  return { program, written, openUrl };
}

describe('kimi install-desktop', () => {
  it('prints the region-derived desktop app page URL and opens it in the browser', async () => {
    const { program, written, openUrl } = createProgram();

    await program.parseAsync(['node', 'kimi', 'install-desktop']);

    expect(written).toHaveBeenCalledWith('https://example.com/code\n');
    expect(openUrl).toHaveBeenCalledWith('https://example.com/code');
  });

  it('keeps install-app working as a hidden alias', async () => {
    const { program, written, openUrl } = createProgram();

    await program.parseAsync(['node', 'kimi', 'install-app']);

    expect(written).toHaveBeenCalledWith('https://example.com/code\n');
    expect(openUrl).toHaveBeenCalledWith('https://example.com/code');
  });
});
