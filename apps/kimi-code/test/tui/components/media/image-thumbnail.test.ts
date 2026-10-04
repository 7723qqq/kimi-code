import { resetCapabilitiesCache, setCapabilities, visibleWidth } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImageThumbnail } from '#/tui/components/media/image-thumbnail';
import { InlineImage } from '#/tui/components/media/inline-image';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';
import type * as imagePixelsModule from '#/tui/utils/image-pixels';
import { decodeImagePixels } from '#/tui/utils/image-pixels';

vi.mock('#/tui/utils/image-pixels', async (importOriginal) => {
  const mod = await importOriginal<typeof imagePixelsModule>();
  return { ...mod, decodeImagePixels: vi.fn(mod.decodeImagePixels) };
});

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

/** Extract the `c=<columns>` control from a kitty graphics line, if present. */
function kittyColumns(line: string): number | undefined {
  const match = /\bc=(\d+)/.exec(line);
  return match === null ? undefined : Number(match[1]);
}

/** True when a rendered line carries a sixel DCS sequence. */
function hasSixel(line: string): boolean {
  return line.includes('\u001BPq');
}

describe('ImageThumbnail', () => {
  afterEach(() => {
    resetCapabilitiesCache();
    vi.restoreAllMocks();
  });

  it('keeps rendered output within narrow widths', () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });

    const component = new ImageThumbnail(image);

    for (const width of [39, 20, 3, 1]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('does not rebuild inline image children on repeated same-width renders', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });

    const bufferFrom = vi.spyOn(Buffer, 'from');
    const component = new ImageThumbnail(image);
    bufferFrom.mockClear();

    component.render(80);
    component.render(80);

    expect(bufferFrom).not.toHaveBeenCalled();
  });
});

describe('InlineImage', () => {
  afterEach(() => {
    resetCapabilitiesCache();
    vi.restoreAllMocks();
  });

  it('shows an enriched fallback marker without image protocols', () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });

    const component = new InlineImage({
      base64: PNG_B64,
      mime: 'image/png',
      width: 800,
      height: 600,
      label: 'image #1',
      byteLength: 70,
    });

    const [line] = component.render(80);
    expect(line).toContain('image #1 (800×600)');
    expect(line).toContain('PNG');
    expect(line).toContain('70 B');
  });

  it('renders a placeholder first on sixel terminals, then swaps in the image', async () => {
    setCapabilities({ images: 'sixel', trueColor: true, hyperlinks: true });

    const component = new InlineImage({
      base64: PNG_B64,
      mime: 'image/png',
      width: 1,
      height: 1,
      label: 'image #1',
      byteLength: 70,
    });

    const [placeholder] = component.render(80);
    expect(placeholder).toContain('image #1');

    await vi.waitFor(() => {
      const lines = component.render(80);
      expect(lines.some(hasSixel)).toBe(true);
    });
  });

  it('keeps the placeholder when the payload cannot be decoded', async () => {
    setCapabilities({ images: 'sixel', trueColor: true, hyperlinks: true });

    const component = new InlineImage({
      base64: 'bm90LWFuLWltYWdl',
      mime: 'image/png',
      width: 1,
      height: 1,
      label: 'image #1',
    });

    const [placeholder] = component.render(80);
    expect(placeholder).toContain('image #1');

    // Give the failed decode a chance to settle; the placeholder must stay.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [again] = component.render(80);
    expect(again).toContain('image #1');
    expect(again).not.toContain('\u001BPq');
  });

  it('scales image width with the available terminal width', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });

    const component = new InlineImage({
      base64: PNG_B64,
      mime: 'image/png',
      width: 800,
      height: 600,
      label: 'image #1',
    });

    const wideColumns = component.render(120).map(kittyColumns).find((c) => c !== undefined);
    const narrowColumns = component.render(30).map(kittyColumns).find((c) => c !== undefined);

    // Wide terminals get a wider picture; both stay within the 60-col cap.
    expect(wideColumns).toBeGreaterThan(narrowColumns ?? 0);
    expect(wideColumns).toBeLessThanOrEqual(60);
  });

  it('renders a single-line marker when too narrow for a picture', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });

    const component = new InlineImage({
      base64: PNG_B64,
      mime: 'image/png',
      width: 800,
      height: 600,
      label: 'image #1',
    });

    const lines = component.render(15);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(15);
  });

  it('retries decoding a failed sixel decode on a width-triggered rebuild', async () => {
    setCapabilities({ images: 'sixel', trueColor: true, hyperlinks: true });

    const mockedDecode = vi.mocked(decodeImagePixels);
    mockedDecode.mockReset();
    mockedDecode.mockResolvedValueOnce(null);
    mockedDecode.mockResolvedValueOnce({
      pixels: new Uint8Array(4),
      width: 1,
      height: 1,
    });

    const component = new InlineImage({
      base64: PNG_B64,
      mime: 'image/png',
      width: 1,
      height: 1,
      label: 'image #1',
    });

    // First decode fails → placeholder stays.
    component.render(80);
    await vi.waitFor(() => expect(mockedDecode).toHaveBeenCalledTimes(1));
    expect(component.render(80).some(hasSixel)).toBe(false);

    // A width change rebuilds children, which retries the decode and swaps
    // the image in.
    await vi.waitFor(() => {
      const lines = component.render(120);
      expect(lines.some(hasSixel)).toBe(true);
    });
    expect(mockedDecode).toHaveBeenCalledTimes(2);
  });
});
