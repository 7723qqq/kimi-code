/**
 * TUI2 cache hint controller — drives the "cache expired" dialog for the two
 * trigger scenarios: resuming a long-idle session (fires right after the
 * resume finishes loading) and submitting after an in-process idle stretch
 * (intercepts the submit). Owns the frequency guards and the in-process
 * activity baseline; the pure trigger rule lives in `../utils/cache-hint`.
 *
 * Mirrors `tui/controllers/cache-hint-controller.ts` with the pi-tui dialog
 * mounting swapped for response-store state (`activeDialog` +
 * `cacheHintDialog`); the dialog component resolves via
 * `resolveDialog(action)`.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import { log, type KimiHarness, type Session, type TokenUsage } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';
import { getCacheHintConfig, peekCacheHintConfig } from '#/utils/cache-hint-config';

import { currentTuiConfig } from '../commands/config';
import type { CacheHintAction } from '../components/dialogs/cache-hint-dialog';
import { saveTuiConfig } from '../config';
import { MAIN_AGENT_ID } from '../constant/kimi-tui';
import type { Tui2Store } from '../state';
import type { AppState } from '../types';
import { evaluateCacheHint } from '../utils/cache-hint';
import { formatErrorMessage } from '../utils/event-payload';
import type { ExtractionResult } from '../utils/image-placeholder';

/** A swallowed submit: the raw text plus its media extraction (done before
 *  the dialog so pasted attachments survive a later store clear). */
interface StashedSubmit {
  readonly text: string;
  readonly extraction?: ExtractionResult;
}

export interface CacheHintHost {
  readonly engineV2: boolean;
  readonly harness: KimiHarness;
  readonly session: Session | undefined;
  readonly store: Tui2Store;
  track(event: string, props?: Record<string, unknown>): void;
  setAppState(patch: Partial<AppState>): void;
  showError(message: string): void;
  createNewSession(): Promise<void>;
  sendNormalUserInput(text: string, preExtracted?: ExtractionResult): Promise<void>;
  restoreInputText(text: string): void;
}

type HintDecision = { readonly idleSeconds: number; readonly totalTokens: number };

/** Cache-break detection: a step's cache read dropping under 95% of the
 *  previous step's by more than this many tokens counts as a break. */
const CACHE_BREAK_MIN_DROP_TOKENS = 2000;
const CACHE_BREAK_DROP_RATIO = 0.95;

interface CacheBreakBaseline {
  readonly model: string;
  readonly effort: string;
  readonly usage: TokenUsage;
  readonly time: number;
}

export interface CacheHintController {
  noteStepUsage(usage: TokenUsage | undefined): void;
  resetCacheBreakBaseline(): void;
  recordActivity(): void;
  onTurnBegin(): void;
  resetRuntime(): void;
  refreshConfigInBackground(): void;
  maybeShowOnResume(): Promise<void>;
  maybeInterceptOnSubmit(text: string, extraction?: ExtractionResult): boolean;
  /** Resolve the open cache-hint dialog with the user's action. */
  resolveDialog(action: CacheHintAction | 'dismiss'): void;
}

export function createCacheHintController(host: CacheHintHost): CacheHintController {
  /** Latest in-process LLM round-trip time (turn begin / turn end). */
  let lastActivityAt: number | undefined;
  /** One prompt per idle cycle; reset when a real send starts a turn. */
  let idlePrompted = false;
  /** Cold-cache trigger fetches at most once per idle cycle (loop guard for
   *  the release-and-resend path). */
  let triggerFetchAttempted = false;
  /** Swallowed submits waiting on the cold-cache interception chain. */
  let pendingInterceptions = 0;
  /** FIFO chain serializing swallowed submits so they keep submit order. */
  let interceptionTail: Promise<void> = Promise.resolve();
  /** Set while a stashed message is being released back into the send path. */
  let releasingStashed = false;
  /** Whether the idle dialog's triggering message was restored, not sent. */
  let lastDialogRestored = false;
  /** Inputs restored this cycle — chained restores append (newline-joined)
   *  instead of overwriting the editor. */
  let restoredTexts: string[] = [];
  /** Resume scenario fires at most once per session per TUI instance. */
  const resumedSessions = new Set<string>();
  /** Last measured main-loop step usage for cache-break detection. */
  let breakBaseline: CacheBreakBaseline | undefined;
  /** Resolver for the currently open cache-hint dialog. */
  let dialogResolver: ((action: CacheHintAction | 'dismiss') => void) | undefined;

  const upstreamModelId = (): string | undefined => {
    const { model, availableModels, availableProviders } = host.store.state;
    const alias = availableModels[model];
    if (alias === undefined) return undefined;
    // The cache rules describe the managed service's server-side cache, so
    // they only apply to OAuth-managed providers — apiKey or self-hosted
    // providers never hint.
    if (availableProviders[alias.provider]?.oauth === undefined) return undefined;
    return alias.model;
  };

  const resolveConfig = async (): Promise<ReturnType<typeof getCacheHintConfig> | undefined> => {
    let accessToken: string | undefined;
    try {
      accessToken = await host.harness.auth.getCachedAccessToken();
    } catch {
      // Facade unavailable (test doubles) — never fetch.
      return undefined;
    }
    // The endpoint is public: apiKey-only users fetch anonymously.
    return getCacheHintConfig({ accessToken });
  };

  const restoreStashedInput = (text: string | undefined): void => {
    if (text === undefined) return;
    restoredTexts.push(text);
    host.restoreInputText(restoredTexts.join('\n'));
  };

  /** Release a stashed message through the normal send path, bypassing the
   *  interception gate so the re-entry cannot start a second fetch. */
  const releaseStashed = async (stash: StashedSubmit): Promise<void> => {
    releasingStashed = true;
    try {
      await host.sendNormalUserInput(stash.text, stash.extraction);
    } finally {
      releasingStashed = false;
    }
  };

  const showDialog = async (
    scene: 'resume' | 'idle',
    decision: HintDecision,
    stashed: StashedSubmit | undefined,
  ): Promise<void> => {
    host.track('cache_hint_shown', {
      scene,
      model: host.store.state.model,
      idle_seconds: decision.idleSeconds,
      total_tokens: decision.totalTokens,
    });
    const action = await new Promise<CacheHintAction | 'dismiss'>((resolve) => {
      dialogResolver = resolve;
      host.store.setState('activeDialog', 'cache-hint');
      host.store.setState('cacheHintDialog', {
        idleSeconds: decision.idleSeconds,
        totalTokens: decision.totalTokens,
      });
    });
    dialogResolver = undefined;
    host.store.setState('activeDialog', null);
    host.store.setState('cacheHintDialog', null);
    host.track('cache_hint_action', { action, scene });
    await runAction(action, stashed);
  };

  const runAction = async (
    action: CacheHintAction | 'dismiss',
    stashed: StashedSubmit | undefined,
  ): Promise<void> => {
    const restoreInput = (): void => {
      lastDialogRestored = true;
      restoreStashedInput(stashed?.text);
    };
    switch (action) {
      case 'dismiss':
        restoreInput();
        return;
      case 'never':
        host.setAppState({ cacheExpiryHint: false });
        try {
          await saveTuiConfig({
            ...currentTuiConfig({ state: { appState: host.store.state } }),
            cacheExpiryHint: false,
          });
        } catch {
          host.showError(t('tui.statusMessages.cacheHintPreferenceSaveFailed'));
        }
        break;
      case 'compact': {
        const session = host.session;
        if (session !== undefined) {
          try {
            await session.compact({});
          } catch (error) {
            host.showError(
              t('tui.statusMessages.cacheCompactFailed', { error: formatErrorMessage(error) }),
            );
            restoreInput();
            return;
          }
          if (stashed !== undefined) {
            // compact() is trigger-only — the engine engages asynchronously.
            // Wait for the engagement barrier so the resend lands in the
            // queue and drains automatically when compaction finishes.
            if (!(await waitForCompactionStart())) {
              host.showError(t('tui.statusMessages.cacheCompactNotStarted'));
              restoreInput();
              return;
            }
          }
        }
        break;
      }
      case 'new': {
        const previousId = host.store.state.sessionId;
        await host.createNewSession();
        if (host.store.state.sessionId === previousId) {
          // Creation failed (error already surfaced); keep the input for retry.
          restoreInput();
          return;
        }
        break;
      }
      case 'continue':
        break;
    }
    lastDialogRestored = false;
    if (stashed !== undefined) await host.sendNormalUserInput(stashed.text, stashed.extraction);
  };

  /** Bounded wait for the engine to flip `isCompacting` after a compact RPC. */
  const waitForCompactionStart = async (timeoutMs = 3000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (host.store.state.isCompacting) return true;
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    return false;
  };

  /** Cold-cache path: fetch the config, then show the dialog or release. */
  const interceptAfterFetch = async (stash: StashedSubmit, sessionId: string): Promise<void> => {
    // A dialog already ran for this idle cycle: chained submits follow the
    // fate of the message that opened it. If that message was restored
    // (dismissed or its action failed), restore these too — sending them now
    // would reorder the conversation.
    if (idlePrompted) {
      if (lastDialogRestored) {
        restoreStashedInput(stash.text);
      } else {
        await releaseStashed(stash);
      }
      return;
    }
    const config = await resolveConfig();
    // The fetch window is unbounded for the user: if they switched sessions
    // meanwhile, never send the stashed text into the wrong session — hand it
    // back to the editor instead.
    if (host.session?.id !== sessionId) {
      restoreStashedInput(stash.text);
      return;
    }
    // If a foreground operation (turn, /compact, …) started meanwhile, don't
    // mount over it — release through the normal path, which queues behind
    // the running operation.
    if (
      host.store.state.streamingPhase !== 'idle' ||
      host.store.state.isCompacting
    ) {
      await releaseStashed(stash);
      return;
    }
    if (config !== undefined) {
      const decision = evaluateCacheHint({
        now: Date.now(),
        lastActiveAt: lastActivityAt ?? 0,
        totalTokens: host.store.state.contextTokens,
        modelId: upstreamModelId(),
        config,
        dismissed: false,
      });
      if (decision.kind === 'hint') {
        idlePrompted = true;
        await showDialog('idle', decision, stash);
        return;
      }
    }
    // No hint (fetch failed or rules don't match): release the message. The
    // re-entry skips the fetch (fresh cache or triggerFetchAttempted) and
    // flows straight to send.
    await releaseStashed(stash);
  };

  return {
    noteStepUsage(usage: TokenUsage | undefined): void {
      lastActivityAt = Date.now();
      if (usage === undefined) return;
      if (
        usage.inputOther === 0 &&
        usage.output === 0 &&
        usage.inputCacheRead === 0 &&
        usage.inputCacheCreation === 0
      ) {
        return;
      }
      const model = host.store.state.model;
      const effort = host.store.state.thinkingEffort;
      const now = Date.now();
      const prev = breakBaseline;
      breakBaseline = { model, effort, usage, time: now };
      if (prev === undefined) return;
      const prevRead = prev.usage.inputCacheRead;
      const currRead = usage.inputCacheRead;
      if (currRead >= prevRead * CACHE_BREAK_DROP_RATIO) return;
      if (prevRead - currRead <= CACHE_BREAK_MIN_DROP_TOKENS) return;
      // Surface the break in the logs as well as telemetry: the server-side
      // prompt cache was likely invalidated (prefix change, cache expiry, or a
      // mid-session model/effort switch). Telemetry props are flattened snake_case.
      log.warn(
        `[cache] prompt-cache break detected: cache read dropped ${prevRead - currRead} ` +
          `tokens (${Math.round(((prevRead - currRead) / prevRead) * 100)}%) between steps, ` +
          `${((now - prev.time) / 1000).toFixed(1)}s after the previous request ` +
          `(model ${prev.model} -> ${model}, effort ${prev.effort} -> ${effort})`,
      );
      host.track('cache_break_detected', {
        prev_model: prev.model,
        curr_model: model,
        prev_effort: prev.effort,
        curr_effort: effort,
        prev_input_cache_read: prevRead,
        curr_input_cache_read: currRead,
        prev_input_other: prev.usage.inputOther,
        curr_input_other: usage.inputOther,
        prev_output: prev.usage.output,
        curr_output: usage.output,
        prev_input_cache_creation: prev.usage.inputCacheCreation,
        curr_input_cache_creation: usage.inputCacheCreation,
        cache_read_drop_ratio: (prevRead - currRead) / prevRead,
        interval_ms: now - prev.time,
      });
    },

    resetCacheBreakBaseline(): void {
      breakBaseline = undefined;
    },

    recordActivity(): void {
      lastActivityAt = Date.now();
    },

    onTurnBegin(): void {
      idlePrompted = false;
      triggerFetchAttempted = false;
      lastDialogRestored = false;
      restoredTexts = [];
    },

    resetRuntime(): void {
      lastActivityAt = undefined;
      idlePrompted = false;
      triggerFetchAttempted = false;
      lastDialogRestored = false;
      restoredTexts = [];
      breakBaseline = undefined;
    },

    refreshConfigInBackground(): void {
      void resolveConfig();
    },

    async maybeShowOnResume(): Promise<void> {
      const session = host.session;
      if (!host.engineV2 || session === undefined) return;
      if (resumedSessions.has(session.id)) return;
      const main = session.getResumeState()?.agents[MAIN_AGENT_ID];
      let lastActiveAt = 0;
      for (const record of main?.replay ?? []) {
        // Only message/compaction records correspond to LLM round-trips; state
        // records (permission/plan/config updates, approval results) can be
        // appended by slash commands without touching the cache.
        if (record.type !== 'message' && record.type !== 'compaction') continue;
        if (record.time > lastActiveAt) lastActiveAt = record.time;
      }
      // `summary.updatedAt` ≈ last user prompt — a coarser but valid fallback.
      if (lastActiveAt === 0) lastActiveAt = session.summary?.updatedAt ?? 0;
      if (lastActiveAt === 0) return;
      const config = await resolveConfig();
      // The config fetch above can outlive the user's patience: if they switched
      // sessions meanwhile, this dialog (and its actions) would target the wrong
      // session — drop it. Likewise, if they already sent the first prompt and
      // a turn is now running, don't mount over the active turn.
      if (host.session !== session) return;
      if (host.store.state.streamingPhase !== 'idle' || host.store.state.isCompacting) {
        return;
      }
      // Fold in-process activity into the replay-derived baseline before
      // judging: a turn may have completed during the fetch, and a completed
      // turn refreshes the server-side cache — the stale replay timestamp would
      // warn about an expiration the user just paid to fix. Seeding the
      // baseline either way also lets a resume inside the cache window expire
      // via the idle-submit path while the user idles in the TUI.
      lastActiveAt = Math.max(lastActiveAt, lastActivityAt ?? 0);
      lastActivityAt = lastActiveAt;
      const decision = evaluateCacheHint({
        now: Date.now(),
        lastActiveAt,
        totalTokens: main?.context.tokenCount,
        modelId: upstreamModelId(),
        config,
        dismissed: host.store.state.cacheExpiryHint === false,
      });
      if (decision.kind === 'skip') return;
      resumedSessions.add(session.id);
      // The resume dialog also covers this idle cycle: the first submit right
      // after it must not be intercepted again.
      idlePrompted = true;
      await showDialog('resume', decision, undefined);
    },

    maybeInterceptOnSubmit(text: string, extraction?: ExtractionResult): boolean {
      if (!host.engineV2 || host.session === undefined) return false;
      // A stashed message being released re-enters the send path here — never
      // re-intercept it (that would start a second fetch loop).
      if (releasingStashed) return false;
      if (idlePrompted || lastActivityAt === undefined) return false;
      if (
        host.store.state.streamingPhase !== 'idle' ||
        host.store.state.isCompacting
      ) {
        return false;
      }
      if (host.store.state.cacheExpiryHint === false) return false;
      // Providers that can never match a cache rule (apiKey / self-hosted) must
      // not pay the cold-fetch stall below — no hint can ever come of it.
      if (upstreamModelId() === undefined) return false;
      // Coarse floor: configured cache durations are 10min+, so anything
      // fresher than a minute can never hint.
      if (Date.now() - lastActivityAt < 60_000) return false;
      const stash: StashedSubmit = { text, extraction };
      const cached = peekCacheHintConfig();
      if (cached !== undefined) {
        const decision = evaluateCacheHint({
          now: Date.now(),
          lastActiveAt: lastActivityAt,
          totalTokens: host.store.state.contextTokens,
          modelId: upstreamModelId(),
          config: cached,
          dismissed: false,
        });
        if (decision.kind === 'skip') return false;
        idlePrompted = true;
        // Mounts synchronously inside; the action resolution runs async.
        void showDialog('idle', decision, stash);
        return true;
      }
      // Config cache cold: fetch at trigger time. Submits arriving while the
      // interception is in flight are swallowed too and replayed through a FIFO
      // chain, so a later prompt can never overtake the stashed one. A fetch
      // that already failed this cycle falls through to the normal send path.
      if (triggerFetchAttempted && pendingInterceptions === 0) return false;
      triggerFetchAttempted = true;
      const sessionId = host.session.id;
      pendingInterceptions += 1;
      interceptionTail = interceptionTail
        .then(() => interceptAfterFetch(stash, sessionId))
        .finally(() => {
          pendingInterceptions -= 1;
        });
      return true;
    },

    resolveDialog(action: CacheHintAction | 'dismiss'): void {
      dialogResolver?.(action);
    },
  };
}
