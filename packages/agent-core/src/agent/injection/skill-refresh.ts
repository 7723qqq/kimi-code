import { DynamicInjector } from './injector';

/**
 * Surfaces an up-to-date skill listing when plugins are hot-loaded mid-session.
 *
 * The base system prompt bakes in the skill listing once at bootstrap and is
 * intentionally NOT rewritten on `/plugins reload` — rewriting it would bust the
 * prompt-cache prefix for the whole conversation and reset runtime state. Instead
 * this injector appends the current listing as a system reminder. The listing's
 * "DISREGARD any earlier skill listings" header makes it supersede the stale one
 * still sitting in the prompt. The base class re-injects after compaction scrolls
 * the reminder out, so the model never loses the up-to-date listing.
 */
export class SkillRefreshInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'skills_reloaded';
  private surfaced: string | undefined;

  override onContextClear(): void {
    super.onContextClear();
    this.surfaced = undefined;
  }

  override getInjection(): string | undefined {
    const registry = this.agent.skills?.registry;
    if (registry === undefined) return undefined;
    const baseline = this.agent.systemPromptSkillListing;
    const current = registry.getModelSkillListing();
    if (current.length === 0) return undefined;
    // Native resume replays the system prompt from records without calling
    // useProfile, so no baseline exists. In that case, compare against the
    // replayed prompt string itself: if it already contains the current listing,
    // there is nothing to surface; otherwise a plugin was added after the prompt
    // was recorded and the model needs the fresh listing.
    if (baseline === undefined && this.agent.config?.systemPrompt.includes(current)) {
      return undefined;
    }
    // While the live listing still matches the one baked into the system
    // prompt, there is nothing extra to surface.
    if (baseline !== undefined && current === baseline) return undefined;
    // The listing drifted from the prompt baseline. Surface it once; only
    // re-surface if it changed again or scrolled out of context via compaction
    // (the base class nulls `injectedAt` in that case).
    if (this.injectedAt !== null && this.surfaced === current) return undefined;
    this.surfaced = current;
    return current;
  }
}
