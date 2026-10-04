/**
 * Transcript-side rendering of a pasted image attachment.
 *
 * Thin wrapper over {@link InlineImage} that adapts an `ImageAttachment`
 * (bytes + metadata) to the generic inline-image options. Rendering rules
 * (kitty / iTerm2 / sixel / text fallback) live in `inline-image.ts`.
 */

import { Container } from '@moonshot-ai/pi-tui';

import type { ImageAttachment } from '#/tui/utils/image-attachment-store';

import { InlineImage } from './inline-image';

export class ImageThumbnail extends Container {
  constructor(attachment: ImageAttachment, onInvalidate?: () => void) {
    super();
    this.addChild(
      new InlineImage({
        base64: Buffer.from(attachment.bytes).toString('base64'),
        mime: attachment.mime,
        width: attachment.width,
        height: attachment.height,
        label: `image #${String(attachment.id)}`,
        byteLength: attachment.bytes.length,
        onInvalidate,
      }),
    );
  }
}
