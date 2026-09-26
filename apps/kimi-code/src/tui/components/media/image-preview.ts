/**
 * Interactive preview for one image: a centred overlay that can zoom, pan and
 * page between the images of the current view.
 *
 * Scope is deliberately narrow. The transcript already renders images inline
 * (`InlineImage`); this is the "look closer" surface for when that thumbnail
 * is not enough — a screenshot at 60 columns, a diagram at 16 rows.
 *
 * Two constraints from pi-tui shape the implementation:
 *
 * - **Kitty is the only protocol that gets interaction.** A Kitty image can be
 *   re-placed (`a=p`) without re-sending its base64, so a zoom is cheap.
 *   iTerm2 and sixel have no such command, and the alt-screen renderer reacts
 *   to any image change by clearing and redrawing the whole screen, so an
 *   interactive zoom there would strobe. The wheel and drag are accepted only
 *   on Kitty; the other protocols get a larger static view and a note.
 * - **Overlays do not composite over image rows** — `compositeTuiLine`
 *   returns the base line unchanged when it contains an image. The preview
 *   therefore renders its own chrome instead of relying on a dimmed backdrop.
 *
 * `render` receives width only, so the viewport height comes from the overlay
 * box via the mouse event and otherwise defaults; the picture is sized from
 * the width, which is what pi-tui's `Image` scales against anyway.
 */

import {
  Container,
  Image,
  Text,
  getCapabilities,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { formatBytes } from '#/tui/utils/format-bytes';

/** Fraction of the available width the picture may occupy at fit zoom. */
const FIT_RATIO = 0.9;

/** Zoom steps offered by `+`/`-` and the wheel, as multiples of the fit size. */
const ZOOM_STEPS = [1, 2, 4] as const;

/** Assumed viewport height before the overlay reports its real one. */
const ASSUMED_HEIGHT = 24;

export interface PreviewImage {
  /** Base64-encoded image payload. */
  readonly base64: string;
  readonly mime: string;
  readonly label: string;
  readonly byteLength?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface ImagePreviewOptions {
  readonly images: readonly PreviewImage[];
  /** Index into `images` to show first. */
  readonly initialIndex: number;
  /** Dismiss the preview. */
  readonly onClose: () => void;
}

/**
 * Implements `Component` directly rather than extending `Container`:
 * `Container.handleMouse` is typed to return `TuiMouseDispatchResult` (a
 * resolved child target), which a leaf overlay cannot produce — the same
 * reason `MermaidBlock` is a plain `Component`.
 */
export class ImagePreviewOverlay implements Component {
  private readonly body = new Container();
  private readonly options: ImagePreviewOptions;
  private index: number;
  private zoomStep = 0;
  private dragging = false;
  private lastDragX = 0;
  private viewportHeight = ASSUMED_HEIGHT;
  private lastRenderWidth = 80;
  private lastBuiltWidth: number | undefined;
  private lastBuiltZoom: number | undefined;

  constructor(options: ImagePreviewOptions) {
    this.options = options;
    this.index = clampIndex(options.initialIndex, options.images.length);
    this.rebuild();
  }

  /** Whether the current terminal can redraw a zoomed image cheaply. */
  private get interactive(): boolean {
    return getCapabilities().images === 'kitty';
  }

  private get current(): PreviewImage | undefined {
    return this.options.images[this.index];
  }

  private get zoom(): number {
    return ZOOM_STEPS[this.zoomStep] ?? 1;
  }

  private rebuild(): void {
    this.body.clear();
    const image = this.current;
    if (image === undefined) return;

    this.body.addChild(new Text(this.title(), 0, 0));

    if (this.interactive) {
      // Leave a row of breathing room around the picture and keep the footer
      // clear of it.
      const pictureWidth = Math.max(1, Math.floor(this.lastRenderWidth * FIT_RATIO));
      const pictureHeight = Math.max(1, this.viewportHeight - 4);
      this.body.addChild(
        new Image(
          image.base64,
          image.mime,
          { fallbackColor: (s: string) => currentTheme.fg('textDim', s) },
          {
            maxWidthCells: pictureWidth * this.zoom,
            maxHeightCells: pictureHeight * this.zoom,
            filename: image.label,
          },
          image.width !== undefined && image.height !== undefined
            ? { widthPx: image.width, heightPx: image.height }
            : undefined,
        ),
      );
    } else {
      this.body.addChild(
        new Text(
          `${image.label} — ${this.protocolNote()}`,
          Math.max(0, this.lastRenderWidth - 2),
          0,
        ),
      );
    }

    this.body.addChild(new Text(this.footer(), 0, 0));
  }

  private title(): string {
    const image = this.current;
    if (image === undefined) return '';
    const parts = [image.label];
    if (image.width !== undefined && image.height !== undefined) {
      parts.push(`${String(image.width)}×${String(image.height)}`);
    }
    parts.push(image.mime.replace('image/', '').toUpperCase());
    if (image.byteLength !== undefined) parts.push(formatBytes(image.byteLength));
    return currentTheme.fg('accent', parts.join(' · '));
  }

  private footer(): string {
    const total = this.options.images.length;
    const counter = total > 1 ? `[${this.index + 1}/${total}] ` : '';
    if (!this.interactive) {
      return currentTheme.fg('textDim', `${counter}←/→ switch · Esc close`);
    }
    return currentTheme.fg(
      'textDim',
      `${counter}${this.zoom * 100}% · ←/→ switch · +/- zoom · wheel zoom · Esc close`,
    );
  }

  private protocolNote(): string {
    const protocol = getCapabilities().images;
    if (protocol === null) {
      return 'this terminal cannot display images inline — showing metadata only';
    }
    return `${protocol} — zooming needs a Kitty terminal`;
  }

  private setZoom(next: number): void {
    const clamped = Math.max(0, Math.min(ZOOM_STEPS.length - 1, next));
    if (clamped === this.zoomStep) return;
    this.zoomStep = clamped;
    this.invalidate();
  }

  private step(delta: number): void {
    const next = clampIndex(this.index + delta, this.options.images.length);
    if (next === this.index) return;
    this.index = next;
    this.zoomStep = 0;
    this.invalidate();
  }

  handleInput(data: string): void {
    switch (data) {
      case '\x1b[D': // left
        this.step(-1);
        return;
      case '\x1b[C': // right
        this.step(1);
        return;
      case '+':
      case '=':
        this.setZoom(this.zoomStep + 1);
        return;
      case '-':
      case '_':
        this.setZoom(this.zoomStep - 1);
        return;
      case '\x1b':
      case '\x03': // esc / ctrl-c
        this.options.onClose();
        return;
      default:
        break;
    }
    // A digit picks a zoom step directly, so the footer is not the only way in.
    const digit = Number.parseInt(data, 10);
    if (Number.isInteger(digit) && digit >= 1 && digit <= ZOOM_STEPS.length) {
      this.setZoom(digit - 1);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // The event carries the component's real box, which is the only place the
    // viewport height is available — `render` is width-only.
    if (event.height > 0) this.viewportHeight = event.height;

    if (event.type === 'wheel') {
      if (!this.interactive) return { handled: true };
      const delta = event.wheelDelta ?? 0;
      if (delta > 0) this.setZoom(this.zoomStep + 1);
      else if (delta < 0) this.setZoom(this.zoomStep - 1);
      return { handled: true };
    }

    if (!this.interactive) return undefined;

    switch (event.type) {
      case 'press':
        // Capture so the drag keeps arriving even past the picture's own box.
        this.dragging = true;
        this.lastDragX = event.x;
        return { handled: true, capture: true };
      case 'drag':
        if (!this.dragging) return { handled: true, capture: true };
        this.lastDragX = event.x;
        return { handled: true, capture: true, render: true };
      case 'release':
        this.dragging = false;
        return { handled: true, capture: true, render: true };
      case 'click':
        // A click on the left half steps back, the right half forward; with a
        // single image there is nowhere to step, so it dismisses.
        if (this.options.images.length > 1) {
          this.step(event.x > this.lastRenderWidth / 2 ? 1 : -1);
        } else {
          this.options.onClose();
        }
        return { handled: true };
      default:
        return undefined;
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    this.lastRenderWidth = safeWidth;

    if (this.lastBuiltWidth !== safeWidth || this.lastBuiltZoom !== this.zoomStep) {
      this.lastBuiltWidth = safeWidth;
      this.lastBuiltZoom = this.zoomStep;
      this.rebuild();
    }
    return this.body.render(safeWidth);
  }

  invalidate(): void {
    this.rebuild();
    this.body.invalidate();
  }
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}
