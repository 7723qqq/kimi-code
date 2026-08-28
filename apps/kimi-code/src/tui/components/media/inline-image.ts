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
 * Width adapts to the available columns: narrow terminals fill the usable
 * width, wide terminals cap at `MAX_IMAGE_WIDTH`. Height is capped at ~16
 * rows so a single screenshot can't monopolize the viewport; pi-tui handles
 * proportional scaling internally.
 */

import {
  Container,
  Image,
  Text,
  truncateToWidth,
  type ImageTheme,
  getCapabilities,
  type ImageProtocol,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { formatBytes } from '#/tui/utils/format-bytes';
import { decodeImagePixels, type DecodedImagePixels } from '#/tui/utils/image-pixels';

/** Image height cap in terminal rows — keeps a screenshot from owning the viewport. */
const MAX_IMAGE_ROWS = 16;
/** Absolute image width cap in terminal columns (wide terminals). */
const MAX_IMAGE_WIDTH = 60;
/** Image never shrinks below this many columns once the picture is shown. */
const MIN_IMAGE_WIDTH = 20;
/** Fraction of usable width the image may occupy (clamped into the min/max range). */
const IMAGE_WIDTH_RATIO = 0.6;

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
  /**
   * Called when this component's output changes outside of a parent-driven
   * render (the async sixel pixel swap). Parents that render this component
   * manually — rather than mounting it in the component tree — must use it to
   * drop their own render caches, or the swap stays invisible.
   */
  readonly onInvalidate?: () => void;
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
        this.addChild(new Text(this.truncatedFallbackText(width), 0, 0));
        this.requestPixels();
      }
      this.lastBuiltWidth = width;
      return;
    }

    if (caps.images !== 'kitty' && caps.images !== 'iterm2') {
      this.addChild(new Text(this.truncatedFallbackText(width), 0, 0));
      this.lastBuiltWidth = width;
      return;
    }

    this.addChild(this.buildImage(width));
    this.lastBuiltWidth = width;
  }

  /**
   * Picture width in terminal columns for a given usable width: fill a
   * fraction of the available columns, clamped so narrow terminals never
   * drop below `MIN_IMAGE_WIDTH` and wide ones never exceed `MAX_IMAGE_WIDTH`.
   */
  private imageWidthCells(width: number): number {
    const available = Math.max(1, width - 2);
    const target = Math.floor(available * IMAGE_WIDTH_RATIO);
    return Math.max(MIN_IMAGE_WIDTH, Math.min(MAX_IMAGE_WIDTH, target));
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
        maxWidthCells: this.imageWidthCells(width),
        filename: this.options.label,
        pixels: pixels?.pixels,
        pixelWidth: pixels?.width,
        pixelHeight: pixels?.height,
      },
      widthPx !== undefined && heightPx !== undefined ? { widthPx, heightPx } : undefined,
    );
  }

  private requestPixels(): void {
    if (this.pixelsRequested) return;
    this.pixelsRequested = true;
    void (async () => {
      const decoded = await decodeImagePixels(this.options.base64);
      if (decoded === null) {
        // Undecodable payload — release the in-flight guard so a later
        // re-render (e.g. after a transcript reload or width change) gets a
        // chance to decode again instead of being stuck on the placeholder.
        this.pixelsRequested = false;
        return;
      }
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

  /** Fallback marker truncated to the usable width, so it never wraps. */
  private truncatedFallbackText(width: number): string {
    return truncateToWidth(this.fallbackText(), Math.max(0, width - 2));
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    this.lastRenderWidth = safeWidth;

    if (safeWidth < MIN_IMAGE_WIDTH + 2) {
      // Too narrow to show the picture — a single-line marker (truncated to
      // the available width rather than wrapped into a multi-line blob).
      return [truncateToWidth(this.fallbackText(), safeWidth)];
    }

    const caps = getCapabilities();
    if (this.lastBuiltWidth !== safeWidth || this.lastBuiltProtocol !== caps.images) {
      this.buildChildren(safeWidth);
    }
    return super.render(safeWidth);
  }

  override invalidate(): void {
    this.options.onInvalidate?.();
    this.buildChildren(this.lastRenderWidth);
    super.invalidate();
  }
}
