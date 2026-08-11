/**
 * `media` domain — owner-scoped resolution of the `[image]` config limits.
 *
 * One instance per owner (the port of v1's `ImageLimits` from agent-core):
 * the owner pushes its config on load and reload via
 * {@link ImageLimits.setConfig}, and every consumer resolves through the
 * instance it was handed. Nothing is stored in module state, so two owners
 * in one process each compress with their own `[image]` settings and a
 * reload of one never restamps the other.
 *
 * Resolution precedence per value: env var > owning config > global config
 * > built-in default. Env stays process-level on purpose — it is the
 * operator's override for everything in the process. The global config
 * layer (pushed by the `image` config bridge through
 * `setConfiguredMaxImageEdgePx` / `setConfiguredReadImageByteBudget`)
 * ensures ownerless call sites and instances without per-instance config
 * still respect config.toml.
 *
 * Production wiring prefers the DI `ImageConfigBridge`; this class is the
 * dependency-free equivalent for owners that resolve limits imperatively
 * (mirroring v1's `new ImageLimits(env, config)` pattern).
 */

import type { ImageConfig } from './configSection';
import {
  maxImageEdgeFromEnv,
  readImageByteBudgetFromEnv,
  resolveMaxImageEdgePx,
  resolveReadImageByteBudget,
} from './image-compress';

export class ImageLimits {
  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private config: ImageConfig | undefined = undefined,
  ) {}

  /** Push (or clear, with `undefined`) the owning config. Called by the
   * config owner on load and reload, so limits hot-reload per owner. */
  setConfig(config: ImageConfig | undefined): void {
    this.config = config;
  }

  /** Longest-edge ceiling (px) for compressing images for the model. */
  maxEdgePx(): number {
    return maxImageEdgeFromEnv(this.env) ?? this.config?.maxEdgePx ?? resolveMaxImageEdgePx(this.env);
  }

  /** Raw-byte budget for model-initiated image reads (ReadMediaFile default path). */
  readByteBudget(): number {
    return (
      readImageByteBudgetFromEnv(this.env) ??
      this.config?.readByteBudget ??
      resolveReadImageByteBudget(this.env)
    );
  }
}
