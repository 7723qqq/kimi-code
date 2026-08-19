/**
 * Owner-scoped resolution of the `[image]` config limits.
 *
 * The v2 engine no longer ships an `ImageLimits` class (its image-compress
 * module resolves module-level configured defaults). The SDK keeps the
 * per-owner instance pattern so a harness can resolve compression limits
 * from its own config file: precedence per value is env var > owning config
 * > built-in default.
 */

export interface ImageLimitsConfig {
  readonly maxEdgePx?: number;
  readonly readByteBudget?: number;
}

const MAX_IMAGE_EDGE_ENV = 'KIMI_IMAGE_MAX_EDGE_PX';
const READ_IMAGE_BYTE_BUDGET_ENV = 'KIMI_IMAGE_READ_BYTE_BUDGET';
const DEFAULT_MAX_IMAGE_EDGE_PX = 2000;
const DEFAULT_READ_IMAGE_BYTE_BUDGET = 256 * 1024;

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export class ImageLimits {
  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private config: ImageLimitsConfig | undefined = undefined,
  ) {}

  /** Longest-edge ceiling (px) for compressing images for the model. */
  maxEdgePx(): number {
    return (
      positiveInt(this.env[MAX_IMAGE_EDGE_ENV]) ??
      this.config?.maxEdgePx ??
      DEFAULT_MAX_IMAGE_EDGE_PX
    );
  }

  /** Raw-byte budget for model-initiated image reads. */
  readByteBudget(): number {
    return (
      positiveInt(this.env[READ_IMAGE_BYTE_BUDGET_ENV]) ??
      this.config?.readByteBudget ??
      DEFAULT_READ_IMAGE_BYTE_BUDGET
    );
  }
}
