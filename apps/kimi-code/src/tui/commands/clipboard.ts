import { t } from '#/i18n';
import { safeAvailableFormats } from '#/utils/clipboard/clipboard-common';
import { readClipboardMedia } from '#/utils/clipboard/clipboard-image';
import { clipboard } from '#/utils/clipboard/clipboard-native';

import { nextTranscriptId } from '../utils/transcript-id';
import type { SlashCommandHost } from './dispatch';

/**
 * Diagnose the clipboard paste path. A paste that silently does nothing is
 * otherwise indistinguishable from a key that never arrived, so this reports
 * every stage the paste handler consults: whether the native binding loaded,
 * what formats the clipboard exposes, whether it claims an image, and what a
 * real read returns.
 */
export async function handleClipboardCommand(host: SlashCommandHost): Promise<void> {
  const formats = safeAvailableFormats(clipboard);

  let hasImage: string;
  try {
    hasImage = String(clipboard?.hasImage() ?? false);
  } catch (error) {
    hasImage = t('tui.messages.clipboardProbeFailed', { error: describe(error) });
  }

  let read: string;
  try {
    const media = await readClipboardMedia();
    read =
      media === null
        ? t('tui.messages.clipboardReadEmpty')
        : media.kind === 'video'
          ? t('tui.messages.clipboardReadVideo', { mime: media.mimeType, name: media.filename })
          : media.kind === 'document'
            ? t('tui.messages.clipboardReadDocument', {
                mime: media.mimeType,
                name: media.filename,
              })
            : t('tui.messages.clipboardReadImage', {
                mime: media.mimeType,
                bytes: String(media.bytes.length),
              });
  } catch (error) {
    read = t('tui.messages.clipboardProbeFailed', { error: describe(error) });
  }

  host.appendTranscriptEntry({
    id: nextTranscriptId(),
    kind: 'status',
    turnId: undefined,
    renderMode: 'plain',
    content: t('tui.messages.clipboardReport', {
      platform: process.platform,
      native:
        clipboard === null
          ? t('tui.messages.clipboardNativeMissing')
          : t('tui.messages.clipboardNativeLoaded'),
      formats: formats.length > 0 ? formats.join(', ') : t('tui.messages.clipboardNoFormats'),
      hasImage,
      read,
    }),
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
