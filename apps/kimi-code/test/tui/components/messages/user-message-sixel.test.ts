import { resetCapabilitiesCache, setCapabilities } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UserMessageComponent } from '#/tui/components/messages/user-message';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';

const image: ImageAttachment = {
  id: 1,
  kind: 'image',
  bytes: new Uint8Array([137, 80, 78, 71]),
  mime: 'image/png',
  width: 800,
  height: 600,
  placeholder: '[image #1 (800×600)]',
};

// 1x1 transparent png base64
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('UserMessageComponent image thumbnails (sixel)', () => {
  afterEach(() => {
    resetCapabilitiesCache();
    vi.restoreAllMocks();
  });

  it('swaps the sixel placeholder in through the render cache', async () => {
    setCapabilities({ images: 'sixel', trueColor: true, hyperlinks: true });

    const attachment: ImageAttachment = { ...image, bytes: Buffer.from(PNG_B64, 'base64') };
    const component = new UserMessageComponent('look at this', [attachment]);

    const placeholderFrame = component.render(80).join('\n');
    expect(placeholderFrame).toContain('image #1');

    await vi.waitFor(() => {
      const lines = component.render(80).join('\n');
      expect(lines).toContain('\u001BPq');
    });
  });
});