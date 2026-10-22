import { describe, expect, it, mock, spyOn } from 'bun:test';

import type { KimiRegionProfile } from '@moonshot-ai/kimi-code-oauth';

import { handleDesktopCommand } from '#/tui/commands/desktop';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import * as openUrlModule from '#/utils/open-url';
import * as regionModule from '#/utils/region';

const mocks = {
  openUrl: spyOn(openUrlModule, 'openUrl').mockImplementation(() => {}),
  currentKimiProfile: spyOn(regionModule, 'currentKimiProfile').mockImplementation(
    () => ({ siteBase: 'https://example.com' }) as unknown as KimiRegionProfile,
  ),
};

describe('handleDesktopCommand', () => {
  it('shows the region-derived desktop app page URL and opens it in the browser', async () => {
    const host = { showStatus: mock() } as unknown as SlashCommandHost;

    await handleDesktopCommand(host);

    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('https://example.com/code'));
    expect(mocks.openUrl).toHaveBeenCalledWith('https://example.com/code');
  });
});
