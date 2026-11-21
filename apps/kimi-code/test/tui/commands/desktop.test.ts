import { describe, expect, it, vi } from '@moonshot-ai/testkit/vitest';

import type { KimiRegionProfile } from '@moonshot-ai/kimi-code-oauth';

import { handleDesktopCommand } from '#/tui/commands/desktop';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
  currentKimiProfile: vi.fn(() => ({ siteBase: 'https://example.com' }) as unknown as KimiRegionProfile),
}));

void vi.mock('#/utils/open-url', async () => {
  const actual = await import('#/utils/open-url');
  return { ...actual, openUrl: mocks.openUrl };
});

void vi.mock('#/utils/region', async () => {
  const actual = await import('#/utils/region');
  return { ...actual, currentKimiProfile: mocks.currentKimiProfile };
});

describe('handleDesktopCommand', () => {
  it('shows the region-derived desktop app page URL and opens it in the browser', async () => {
    const host = { showStatus: vi.fn() } as unknown as SlashCommandHost;

    await handleDesktopCommand(host);

    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('https://example.com/code'));
    expect(mocks.openUrl).toHaveBeenCalledWith('https://example.com/code');
  });
});
