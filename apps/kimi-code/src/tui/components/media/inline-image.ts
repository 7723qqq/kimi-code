/**
 * Transcript-side rendering of an image (pasted attachment or ReadMediaFile
 * result).
 *
 * On terminals that speak the Kitty graphics protocol, iTerm2 inline image
 * protocol, or sixel (detected by pi-tui's `getCapabilities()`), we show the
 * actual image. Everywhere else we fall back to a one-line text marker
 * carrying the label, dimensions, format, and byte size — this keeps the
 * transcript readable on Terminal.app / Linux default terminals / `script`
 * recordings without extra chrome.
 *
 * Sixel needs decoded pixels, which pi-tui cannot produce itself: the TUI
 * decodes asynchronously with jimp (`decodeImagePixels`) and swaps the
 * placeholder for the image once the pixels are ready.
 *
 * Height is capped at ~12 rows so a single screenshot can't monopolize the
 * viewport; pi-tui handles proportional scaling internally.
 */

import { Container, Image, Text, type ImageTheme, getCapabilities, type ImageProtocol } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { decodeImagePixels, type DecodedImagePixels } from '#/tui/utils/image-pixels';

const MAX_IMAGE_ROWS = 12;
const MAX_IMAGE_WIDTH = 40;

export interface InlineImageOptions {
  /** Base64-encoded image payload. */
  readonly base64: string;
  readonly mime: string;
  /** Intrinsic pixel dimensions; omitted when unknown (parsed from bytes). */
  readonly width?: number;
  readonly height?: number;
  /** Short label for the fallback marker, e.g. `image #1` or `image`. */
  readonly label: string;
  /** Encoded byte size for the fallback marker. */
  readonly byteLength?: number;
}

const MIME_SHORT: Readonly<Record<string, string>> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WEBP',
  'image/gif': 'GIF',
  'image/bmp': 'BMP',
};

function shortMime(mime: string): string {
  return MIME_SHORT[mime.trim().toLowerCase()] ?? mime;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export class InlineImage extends Container {
  private readonly options: InlineImageOptions;
  private lastRenderWidth = 80;
  private lastBuiltWidth: number | undefined;
  private lastBuiltProtocol: ImageProtocol | undefined;
  private pixels: DecodedImagePixels | undefined;
  private pixelsRequested = false;

  constructor(options: InlineImageOptions) {
    super();
    this.options = options;
    this.buildChildren(this.lastRenderWidth);
  }

  private buildChildren(width: number): void {
    this.clear();
    const caps = getCapabilities();
    this.lastBuiltProtocol = caps.images;

    if (caps.images === 'sixel') {
      if (this.pixels !== undefined) {
        this.addChild(this.buildImage(width, this.pixels));
      } else {
        this.addChild(new Text(this.fallbackText(), 0, 0));
        this.requestPixels();
      }
      this.lastBuiltWidth = width;
      return;
    }

    if (caps.images !== 'kitty' && caps.images !== 'iterm2') {
      this.addChild(new Text(this.fallbackText(), 0, 0));
      this.lastBuiltWidth = width;
      return;
    }

    this.addChild(this.buildImage(width));
    this.lastBuiltWidth = width;
  }

  private buildImage(width: number, pixels?: DecodedImagePixels): Image {
    const theme: ImageTheme = {
      fallbackColor: (s: string) => currentTheme.fg('textDim', s),
    };
    const { base64, mime, width: widthPx, height: heightPx } = this.options;
    return new Image(
      base64,
      mime,
      theme,
      {
        maxHeightCells: MAX_IMAGE_ROWS,
        maxWidthCells: Math.max(1, Math.min(MAX_IMAGE_WIDTH, width - 2)),
        filename: this.options.label,
        pixels: pixels?.pixels,
        pixelWidth: pixels?.width,
        pixelHeight: pixels?.height,
      },
      widthPx !== undefined && heightPx !== undefined
        ? { widthPx, heightPx }
        : undefined,
    );
  }

  private requestPixels(): void {
    if (this.pixelsRequested) return;
    this.pixelsRequested = true;
    void (async () => {
      const decoded = await decodeImagePixels(this.options.base64, this.options.mime);
      if (decoded === null) return; // undecodable — keep the placeholder
      this.pixels = decoded;
      this.invalidate();
    })();
  }

  private fallbackText(): string {
    const { label, mime, width, height, byteLength } = this.options;
    const parts: string[] = [];
    if (width !== undefined && height !== undefined) {
      parts.push(`${label} (${String(width)}×${String(height)})`);
    } else {
      parts.push(label);
    }
    if (mime.length > 0) parts.push(shortMime(mime));
    if (byteLength !== undefined) parts.push(formatBytes(byteLength));
    return currentTheme.fg('accent', `[${parts.join(', ')}]`);
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    this.lastRenderWidth = safeWidth;

    if (safeWidth < MAX_IMAGE_WIDTH + 2) {
      return new Text(this.fallbackText(), 0, 0).render(safeWidth);
    }

    const caps = getCapabilities();
    if (this.lastBuiltWidth !== safeWidth || this.lastBuiltProtocol !== caps.images) {
      this.buildChildren(safeWidth);
    }
    return super.render(safeWidth);
  }

  override invalidate(): void {
    this.buildChildren(this.lastRenderWidth);
    super.invalidate();
  }
}
