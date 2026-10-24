import { randomUUID } from 'node:crypto';

import type { KimiHarness, PromptPart, Session } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import { getLlmNotSetMessage, MAIN_AGENT_ID } from '../constant/kimi-tui';
import { MEDIA_INGESTION_SUBMIT_WAIT_MS } from '../constant/media';
import type { TUIState } from '../tui-state';
import type {
  AppState,
  InlineSkillActivation,
  LivePaneState,
  PreparedSkillActivations,
  QueuedMessage,
  SteerInputItem,
  TranscriptEntry,
} from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import type { ImageAttachmentStore, MediaAttachment } from '../utils/image-attachment-store';
import {
  extractMediaAttachments,
  omitExpiredVideoFileRefs,
  originalsDirForSession,
  pendingMediaIngestions,
  refreshExpiringImageFileRefs,
  resolveOriginalCaptions,
  rewriteMediaPlaceholders,
} from '../utils/image-placeholder';
import type { ExtractionResult } from '../utils/image-placeholder';
import { isSessionOccupiedError } from '../utils/session-lock-errors';
import type { SessionOccupancyPrompt } from './session-occupancy';
import { combineSteerInput } from '../utils/steer-input';
import { nextTranscriptId } from '../utils/transcript-id';
import type { BtwPanelController } from './btw-panel';
import type { CacheHintController } from './cache-hint-controller';
import type { EditorKeyboardController } from './editor-keyboard';
import { StagingLeaseTracker, type StagingLease } from './staging-leases';
import type { StreamingUIController } from './streaming-ui';

export interface SendMessageOptions {
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly videoAttachmentIds?: readonly number[];
  readonly mediaSnapshots?: readonly MediaAttachment[];
  readonly hasMedia?: boolean;
  /**
   * Lease pre-created at extraction time by `sendNormalUserInput`. Dispatch
   * reuses it (carrying its exact-binding submission id); enqueueing defers
   * it — the queue item owns the raw ids and re-leases at dequeue.
   */
  readonly lease?: StagingLease;
}

/**
 * Everything the message-dispatch controller needs from the `KimiTUI`
 * coordinator: shared state, sibling controllers, and the UI side effects
 * (transcript append, error/queue/pane updates) that stay on the coordinator.
 */
export interface MessageDispatchHost {
  readonly harness: KimiHarness;
  readonly state: TUIState;
  deferUserMessages: boolean;
  session: Session | undefined;
  readonly cacheHint: CacheHintController;
  readonly streamingUI: StreamingUIController;
  readonly btwPanelController: BtwPanelController;
  readonly editorKeyboard: EditorKeyboardController;

  ensureSession(): Promise<Session | undefined>;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  removeTranscriptEntries(entries: readonly TranscriptEntry[]): void;
  prepareSkillActivations(
    activations: readonly InlineSkillActivation[],
    mediaSnapshots?: readonly MediaAttachment[],
  ): PreparedSkillActivations;
  releaseSkillArgumentMedia(prepared: PreparedSkillActivations): void;
  showError(message: string): void;
  updateQueueDisplay(): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  setAppState(patch: Partial<AppState>): void;
  runShellCommandFromInput(command: string): Promise<void>;
  track(event: string, properties?: Parameters<KimiHarness['track']>[1]): void;
  showSessionOccupancyPrompt(prompt: SessionOccupancyPrompt): void;
  restoreInputText(text: string): void;
}

function nonEmptyIds(ids: readonly number[] | undefined): readonly number[] | undefined {
  return ids !== undefined && ids.length > 0 ? ids : undefined;
}

/**
 * Owns the send path: user input submission, media extraction/staging-lease
 * hand-off, queueing and draining, prompt/steer/skill/plugin dispatch, and
 * the session-request lifecycle (begin/fail). The staging-lease invariants
 * documented inline are load-bearing — see StagingLeaseTracker.
 */
export class MessageDispatchController {
  private readonly host: MessageDispatchHost;
  private readonly staging: StagingLeaseTracker;
  private readonly imageStore: ImageAttachmentStore;
  private readonly steeringQueuedMessages = new Set<QueuedMessage>();
  private readonly pendingPromptEntries = new Set<TranscriptEntry>();

  constructor(
    host: MessageDispatchHost,
    staging: StagingLeaseTracker,
    imageStore: ImageAttachmentStore,
  ) {
    this.host = host;
    this.staging = staging;
    this.imageStore = imageStore;
  }

  async sendNormalUserInput(text: string, preExtracted?: ExtractionResult): Promise<void> {
    if (this.host.btwPanelController.sendUserInput(text)) return;
    if (this.host.state.appState.model.trim().length === 0) {
      this.host.showError(getLlmNotSetMessage());
      return;
    }
    let extraction: ExtractionResult;
    if (preExtracted === undefined) {
      // A just-pasted image/video may still be finishing its background
      // ingestion (compression/daemon upload): give it a bounded moment so
      // the submit can use the daemon-ref form — a slower image ingestion
      // extracts to the inline fallback instead, a slower video upload
      // refuses the submission below. Undefined when nothing is pending,
      // keeping the media-free send path synchronous.
      const ingestionWait = pendingMediaIngestions(
        text,
        this.imageStore,
        MEDIA_INGESTION_SUBMIT_WAIT_MS,
      );
      if (ingestionWait !== undefined) await ingestionWait;
    }
    try {
      // A cache-hint-swallowed resend passes its pre-dialog extraction back
      // in: the image store may already be cleared (e.g. after "Start a new
      // session"), so re-extracting from the text would lose the media.
      // Bare image paths attach during extraction; their paste-time
      // ingestion (compression/daemon upload) is awaited inside it. A
      // media-free text extracts synchronously, so the submit path only
      // yields when a path actually has to be read.
      const extracted =
        preExtracted ??
        extractMediaAttachments(text, this.imageStore, (attachment, bytes, mime, width, height) =>
          this.host.editorKeyboard.prepareImageAttachment(attachment, bytes, mime, width, height),
        );
      extraction = extracted instanceof Promise ? await extracted : extracted;
      if (preExtracted !== undefined) {
        const parts = refreshExpiringImageFileRefs(
          extraction.parts,
          extraction.imageAttachmentIds,
          this.imageStore,
        );
        if (parts !== extraction.parts) extraction = { ...extraction, parts };
      }
    } catch (error) {
      // A pasted video's daemon upload was unusable (still in flight,
      // failed, expired); nothing was dispatched.
      this.host.showError(
        t('tui.statusMessages.failedToPrepareMediaAttachment', {
          error: formatErrorMessage(error),
        }),
      );
      return;
    }
    // Create the staging lease right after extraction, so every exit below
    // releases through the tracker instead of open-coding ids — a
    // forgotten exit degrades to an unclaimed lease (swept by `releaseAll`)
    // instead of a permanently retained upload. The lease carries the
    // exact-binding submission id: the consuming turn's `turn.started` echoes
    // it as `promptId`. A goal-active submission is steered and binds its
    // lease explicitly in sendMessageInternal, so it gets no id.
    const stagingLease = this.staging.create(
      // One retain per unique id per extraction: dedupe repeated placeholder
      // occurrences so the lease's id multiplicity matches the retain count.
      [...new Set([...extraction.imageAttachmentIds, ...extraction.videoAttachmentIds])],
      [],
      'user',
      extraction.hasMedia && this.host.state.appState.goal?.status !== 'active'
        ? randomUUID()
        : undefined,
    );
    if (!this.validateMediaCapabilities(extraction)) {
      this.staging.release(stagingLease);
      return;
    }
    // Idle cache-hint interception sits before session creation; it is
    // synchronous unless a hint actually fires. Aside from the bounded
    // ingestion wait above and path-image ingestion inside extraction, the
    // send path stays await-free up to sendMessage.
    if (this.host.cacheHint.maybeInterceptOnSubmit(text, extraction)) {
      // The stash owns the extraction from here: its resend re-leases inside
      // the re-entered send path, its restore goes through releaseRecalled
      // (see CacheHintController). Detach so the stash is not double-owned.
      this.staging.defer(stagingLease);
      return;
    }
    let session = this.host.session;
    if (session === undefined) {
      session = await this.host.ensureSession();
      if (session === undefined) {
        this.staging.release(stagingLease);
        return;
      }
    }
    if (extraction.hasMedia) {
      this.sendMessage(session, text, {
        hasMedia: true,
        parts: extraction.parts,
        imageAttachmentIds: extraction.imageAttachmentIds,
        videoAttachmentIds: extraction.videoAttachmentIds,
        lease: stagingLease,
      });
    } else {
      this.sendMessage(session, text);
    }
    this.host.updateQueueDisplay();
    this.host.state.ui.requestRender();
  }

  async sendInlineSkillUserInput(
    text: string,
    activations: readonly InlineSkillActivation[],
    preExtracted?: ExtractionResult,
  ): Promise<void> {
    if (this.host.btwPanelController.sendUserInput(text, activations)) return;
    if (this.host.state.appState.model.trim().length === 0) {
      this.host.showError(getLlmNotSetMessage());
      return;
    }
    const originatingSession = this.host.session;
    const mediaGeneration = this.imageStore.generation;
    let extraction: ExtractionResult;
    if (preExtracted === undefined) {
      // A just-pasted image/video may still be finishing its background
      // ingestion (compression/daemon upload): give it a bounded moment so
      // the submit can use the daemon-ref form — a slower image ingestion
      // extracts to the inline fallback instead, a slower video upload
      // refuses the submission below. Undefined when nothing is pending,
      // keeping the media-free send path synchronous.
      const ingestionWait = pendingMediaIngestions(
        text,
        this.imageStore,
        MEDIA_INGESTION_SUBMIT_WAIT_MS,
      );
      if (ingestionWait !== undefined) await ingestionWait;
      // The ingestion wait can outlive the submit: a session switch (or a
      // store clear) during it must not dispatch the stale prompt's media into
      // the wrong session.
      if (
        (originatingSession !== undefined && this.host.session !== originatingSession) ||
        this.imageStore.generation !== mediaGeneration
      ) {
        this.host.showError(
          t('tui.statusMessages.sessionChangedWhilePreparingMedia'),
        );
        return;
      }
    }
    try {
      const extracted =
        preExtracted ??
        extractMediaAttachments(text, this.imageStore, (attachment, bytes, mime, width, height) =>
          this.host.editorKeyboard.prepareImageAttachment(attachment, bytes, mime, width, height),
        );
      extraction = extracted instanceof Promise ? await extracted : extracted;
    } catch (error) {
      this.host.showError(
        t('tui.statusMessages.failedToPrepareMediaAttachment', {
          error: formatErrorMessage(error),
        }),
      );
      return;
    }
    if (!this.validateMediaCapabilities(extraction)) {
      this.staging.releaseMedia(
        [...extraction.imageAttachmentIds, ...extraction.videoAttachmentIds],
        [],
      );
      return;
    }
    if (this.host.cacheHint.maybeInterceptOnSubmit(text, extraction, activations)) return;
    let session = this.host.session;
    if (session === undefined) {
      // Dispatch only routes here on the v2 engine, so the session is created
      // lazily on first use exactly like a normal prompt.
      session = await this.host.ensureSession();
      if (session === undefined) {
        this.staging.releaseMedia(
          [...extraction.imageAttachmentIds, ...extraction.videoAttachmentIds],
          [],
        );
        return;
      }
    }
    if (
      this.host.deferUserMessages ||
      this.steeringQueuedMessages.size > 0 ||
      this.host.state.appState.streamingPhase !== 'idle' ||
      this.host.state.appState.isCompacting
    ) {
      this.enqueueMessage(
        text,
        extraction.hasMedia
          ? {
              hasMedia: true,
              parts: extraction.parts,
              imageAttachmentIds: extraction.imageAttachmentIds,
              videoAttachmentIds: extraction.videoAttachmentIds,
              mediaSnapshots: extraction.mediaSnapshots,
              inlineSkillActivations: activations,
            }
          : { inlineSkillActivations: activations },
      );
      this.host.updateQueueDisplay();
      this.host.state.ui.requestRender();
      return;
    }
    this.beginSessionRequest();
    void this.runInlineSkillActivations(session, text, activations, extraction).catch(
      (error: unknown) => {
        this.failSessionRequest(
          t('tui.statusMessages.skillActivationFailed', { error: formatErrorMessage(error) }),
        );
      },
    );
  }

  private async runInlineSkillActivations(
    session: Session,
    text: string,
    activations: readonly InlineSkillActivation[],
    extraction: ExtractionResult,
  ): Promise<void> {
    const knownEntryIds = new Set(this.host.state.transcriptEntries.map((entry) => entry.id));
    // The bundled submission owns its pasted media exactly like a plain
    // prompt does: lease the retains now and hand the lease to the dispatch so
    // the consuming `skill_activation` turn releases (deletes) the uploads at
    // turn end. Without a lease nothing ever consumes the retain and the
    // daemon upload outlives the turn, the queue and the session.
    let prepared: PreparedSkillActivations | undefined;
    let input: string | readonly PromptPart[];
    try {
      prepared = this.host.prepareSkillActivations(activations, extraction.mediaSnapshots);
      input = extraction.hasMedia
        ? resolveOriginalCaptions(
            omitExpiredVideoFileRefs(extraction.parts, prepared.cachedVideos),
            extraction.imageAttachmentIds,
            this.imageStore,
            originalsDirForSession(session),
          )
        : text;
    } catch (error) {
      if (prepared !== undefined) this.host.releaseSkillArgumentMedia(prepared);
      this.staging.releaseMedia(
        [...extraction.imageAttachmentIds, ...extraction.videoAttachmentIds],
        [],
      );
      this.failSessionRequest(
        t('tui.statusMessages.failedToPrepareMediaAttachment', {
          error: formatErrorMessage(error),
        }),
      );
      return;
    }
    // `mediaAttachmentIds` multiplicity is the retain count the lease must
    // release: dedupe per contribution (extraction retains once per unique id;
    // each skill arg rewrite retains its own), never across them.
    const stagingLease = this.staging.create(
      [
        ...new Set([...extraction.imageAttachmentIds, ...extraction.videoAttachmentIds]),
        ...prepared.mediaAttachmentIds,
      ],
      prepared.stagingPaths,
      'user',
    );
    // The user entry lands before the dispatch so the submission is never
    // lost: a rejected bundle keeps its history (and its input-recall anchor)
    // instead of vanishing with the failed request.
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: text,
      skillNames: activations.map((activation) => activation.skillName),
      imageAttachmentIds:
        extraction.imageAttachmentIds.length > 0 ? extraction.imageAttachmentIds : undefined,
    });
    const request = session.promptWithSkills(input, prepared.skills);
    this.staging.trackDispatch(stagingLease, request, (error: unknown) => {
      // A rejected bundle never reached a turn: hand the staged media back to
      // raw ownership and release the retains without deleting the daemon
      // uploads — the failed input stays in history and its recall re-submits
      // the same `fileId` (see `retries a failed skill video`).
      if (
        this.host.session === session &&
        stagingLease !== undefined &&
        stagingLease.turnId === undefined
      ) {
        this.staging.defer(stagingLease);
        for (const id of stagingLease.mediaAttachmentIds) this.staging.releaseRecalled([id]);
        this.staging.releaseMedia([], stagingLease.paths);
      }
      this.handleSkillActivationError(session, error);
    });
    // The engine bundles the activations into the prompt's own message, and
    // the `skill.activated` events land synchronously during the call — so
    // the cards appended for this submission are the skill_activation entries
    // with fresh ids (the window trim may replace the entries array mid-call,
    // so membership is decided by id, not by index into a captured array).
    // Marking only happens once the submission was accepted: a rejected
    // bundle leaves no cards and must not leave a local undo anchor the
    // engine never recorded.
    // A rejected submission is handled by `trackDispatch` above; this
    // fulfilment-only handler must not leave the derived promise as an
    // unhandled rejection.
    void request.then(
      () => {
        for (const entry of this.host.state.transcriptEntries) {
          if (entry.kind === 'skill_activation' && !knownEntryIds.has(entry.id)) {
            entry.bundledWithPrompt = true;
          }
        }
      },
      () => {},
    );
  }

  private handleSkillActivationError(session: Session, error: unknown): void {
    if (this.host.session !== session) return;
    const message = t('tui.statusMessages.skillActivationFailed', {
      error: formatErrorMessage(error),
    });
    if (this.host.streamingUI.getTurnContext().turnId === undefined) this.failSessionRequest(message);
    else this.host.showError(message);
  }

  validateMediaCapabilities(extraction: {
    hasMedia: boolean;
    imageAttachmentIds: readonly number[];
    videoAttachmentIds: readonly number[];
    imageSnapshots?: readonly unknown[];
  }): boolean {
    if (!extraction.hasMedia) return true;
    if (
      (extraction.imageAttachmentIds.length > 0 || (extraction.imageSnapshots?.length ?? 0) > 0) &&
      !this.supportsCurrentModelCapability('image_in')
    ) {
      this.host.showError(t('tui.statusMessages.modelNoImageInput'));
      return false;
    }
    if (
      extraction.videoAttachmentIds.length > 0 &&
      !this.supportsCurrentModelCapability('video_in')
    ) {
      this.host.showError(t('tui.statusMessages.modelNoVideoInput'));
      return false;
    }
    return true;
  }

  supportsCurrentModelCapability(capability: string): boolean {
    const capabilities =
      this.host.state.appState.availableModels[this.host.state.appState.model]?.capabilities;
    if (capabilities === undefined) return true;
    return capabilities.includes(capability);
  }

  recallLastQueued(): QueuedMessage | undefined {
    if (this.host.state.queuedMessages.length === 0) return undefined;
    const last = this.host.state.queuedMessages.at(-1)!;
    if (this.steeringQueuedMessages.has(last)) return undefined;
    this.host.state.queuedMessages = this.host.state.queuedMessages.slice(0, -1);
    // A recall restores the draft into the editor — it is not a discard:
    // consumes the retains only, keeping the staged daemon uploads alive
    // (see `releaseRecalled`) so the restored draft resubmits them.
    this.staging.releaseRecalled([
      ...(last.imageAttachmentIds ?? []),
      ...(last.videoAttachmentIds ?? []),
    ]);
    return last;
  }

  /**
   * Cache-hint restore: a dismissed/hand-back interception returns its draft
   * to the editor — same semantics as a queue recall (consume the stash
   * extraction's retains; the staged daemon uploads stay alive for the
   * restored draft).
   */
  recallStashedMedia(extraction: ExtractionResult | undefined): void {
    if (extraction === undefined) return;
    this.staging.releaseRecalled([
      ...extraction.imageAttachmentIds,
      ...extraction.videoAttachmentIds,
    ]);
  }

  // =========================================================================
  // Session Requests / Queues
  // =========================================================================

  enqueueMessage(
    text: string,
    options?: SendMessageOptions & {
      readonly inlineSkillActivations?: readonly InlineSkillActivation[];
    },
    mode?: 'prompt' | 'bash',
  ): void {
    this.host.state.queuedMessages.push(this.toQueuedMessage(text, options, mode));
    this.host.track('input_queue');
  }

  private toQueuedMessage(
    text: string,
    options?: SendMessageOptions & {
      readonly inlineSkillActivations?: readonly InlineSkillActivation[];
    },
    mode?: 'prompt' | 'bash',
  ): QueuedMessage {
    return {
      text,
      agentId: this.host.harness.interactiveAgentId,
      parts: options?.parts,
      imageAttachmentIds: nonEmptyIds(options?.imageAttachmentIds),
      videoAttachmentIds: nonEmptyIds(options?.videoAttachmentIds),
      mode,
      mediaSnapshots: options?.mediaSnapshots,
      inlineSkillActivations: options?.inlineSkillActivations,
    };
  }

  beginSessionRequest(): void {
    this.host.cacheHint.onTurnBegin();
    this.host.streamingUI.setTurnId(undefined);
    this.host.streamingUI.resetLiveText();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.resetToolCallState();

    this.host.patchLivePane({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.host.setAppState({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
  }

  failSessionRequest(message: string): void {
    this.host.setAppState({ streamingPhase: 'idle' });
    this.host.resetLivePane();
    this.host.showError(message);
  }

  sendQueuedMessage(session: Session, item: QueuedMessage): void {
    if (item.mode === 'bash') {
      this.staging.releaseQueued([item]);
      void this.host.runShellCommandFromInput(item.text);
      return;
    }
    if (item.mode === 'skill' && item.skillName !== undefined) {
      // sendSkillActivation re-checks the busy state, so a premature drain
      // re-queues at the tail instead of racing the running turn.
      this.sendSkillActivation(session, item.skillName, item.skillArgs ?? '');
      return;
    }
    if (item.inlineSkillActivations !== undefined && item.inlineSkillActivations.length > 0) {
      // Media was extracted and validated at enqueue time; reuse the queued
      // parts rather than re-extracting from a possibly-cleared image store.
      // Expiring daemon refs refresh at dispatch, same as the plain tail below.
      const refreshed =
        item.parts === undefined
          ? []
          : [
              ...refreshExpiringImageFileRefs(
                item.parts,
                item.imageAttachmentIds ?? [],
                this.imageStore,
              ),
            ];
      this.beginSessionRequest();
      void this.runInlineSkillActivations(session, item.text, item.inlineSkillActivations, {
        parts: refreshed,
        hasMedia: refreshed.length > 0,
        imageAttachmentIds:
          item.imageAttachmentIds !== undefined ? [...item.imageAttachmentIds] : [],
        videoAttachmentIds:
          item.videoAttachmentIds !== undefined ? [...item.videoAttachmentIds] : [],
        imageSnapshots: [],
      }).catch((error: unknown) => {
        this.failSessionRequest(
          t('tui.statusMessages.skillActivationFailed', { error: formatErrorMessage(error) }),
        );
      });
      return;
    }
    const parts =
      item.parts === undefined
        ? undefined
        : refreshExpiringImageFileRefs(item.parts, item.imageAttachmentIds ?? [], this.imageStore);
    this.host.harness.withInteractiveAgent(item.agentId ?? MAIN_AGENT_ID, () => {
      this.sendMessageInternal(session, item.text, {
        parts,
        imageAttachmentIds: item.imageAttachmentIds,
        videoAttachmentIds: item.videoAttachmentIds,
      });
    });
  }

  private sendMessageInternal(session: Session, input: string, options?: SendMessageOptions): void {
    const imageAttachmentIds = nonEmptyIds(options?.imageAttachmentIds);
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: input,
      imageAttachmentIds,
    });
    // A goal-active steer is buffered into the running goal turn — no new
    // turn.started will fire for handleTurnStarted to claim the lease — so
    // bind it to that turn here. The turn context must be read BEFORE
    // beginSessionRequest resets it, and only while a turn is actually live
    // (finalizeTurn clears the id at turn end; a queued dispatch can land
    // while the goal driver's next continuation turn is already streaming).
    const runningTurnId =
      this.host.state.appState.streamingPhase === 'idle' ||
      this.host.state.appState.streamingPhase === 'shell'
        ? undefined
        : this.host.streamingUI.getTurnContext().turnId;
    this.beginSessionRequest();

    // Compression captions for pasted images are authored here — not at
    // extraction — because only now is the session (and its media-originals
    // dir) known: extraction runs before a first session exists.
    const sdkInput =
      options?.parts !== undefined
        ? resolveOriginalCaptions(
            options.parts,
            options.imageAttachmentIds ?? [],
            this.imageStore,
            originalsDirForSession(session),
          )
        : input;
    const goalActive = this.host.state.appState.goal?.status === 'active';
    // The lease normally arrives pre-created by sendNormalUserInput (carrying
    // its exact-binding submission id). Queued dispatches and steer batches
    // arrive with raw ids instead: a prompt submission carrying staged
    // media gets a client-chosen prompt id minted here — the engine echoes it
    // on the consuming turn's `turn.started` (`promptId`), so the lease binds
    // exactly instead of through the origin heuristic. The goal-steer path
    // binds its lease explicitly below, so it gets no id.
    const stagingIds = [
      ...(options?.imageAttachmentIds ?? []),
      ...(options?.videoAttachmentIds ?? []),
    ];
    const stagingLease =
      options?.lease ??
      this.staging.create(
        // One retain per unique id per extraction: dedupe repeated placeholder
        // occurrences so the lease's id multiplicity matches the retain count.
        [...new Set(stagingIds)],
        [],
        'user',
        !goalActive && stagingIds.length > 0 ? randomUUID() : undefined,
      );
    const submissionId = stagingLease?.submissionId;
    // While a goal is being pursued the engine holds its active turn across the
    // whole continuation loop, so a fresh prompt races the goal driver at every
    // continuation boundary and is rejected with `turn.agent_busy`, dropping
    // the message. Steer instead: the engine buffers it into the running goal
    // turn, or launches a turn of its own if the loop just ended.
    if (goalActive) {
      if (runningTurnId !== undefined) this.staging.bindToTurn(stagingLease, runningTurnId);
      this.staging.trackDispatch(stagingLease, session.steer(sdkInput), (error) => {
        // Same reset as the prompt path: beginSessionRequest already moved the
        // TUI to the waiting phase, and no turn events may follow a failed
        // steer (e.g. the session is gone), which would leave the UI stuck
        // queueing input behind a request that never completes.
        this.failSessionRequest(
          t('tui.statusMessages.failedToSteer', { error: formatErrorMessage(error) }),
        );
      });
      return;
    }
    this.staging.trackDispatch(
      stagingLease,
      session.prompt(sdkInput, { promptId: submissionId }),
      (error) => {
        this.failSessionRequest(
          t('tui.statusMessages.failedToSend', { error: formatErrorMessage(error) }),
        );
      },
    );
  }

  sendSkillActivation(session: Session, skillName: string, skillArgs: string): void {
    // Args are a plain-text channel, so pasted media can't ride along as
    // inline parts. Skill args are XML-escaped on render (renderSkillAttributes
    // + expandSkillParameters), so rewrite placeholders into escape-proof
    // plain-text file references the model can open with ReadMediaFile.
    let rewrite: ReturnType<typeof rewriteMediaPlaceholders>;
    try {
      rewrite = rewriteMediaPlaceholders(skillArgs, this.imageStore, 'plain');
    } catch (error) {
      // Cache copy failed (unwritable cache dir, vanished video source…);
      // nothing has been dispatched yet, so just report and keep the input.
      this.host.showError(
        t('tui.statusMessages.failedToPrepareMediaAttachment', {
          error: formatErrorMessage(error),
        }),
      );
      return;
    }
    if (!this.validateMediaCapabilities(rewrite)) {
      this.staging.releaseMedia(rewrite.imageAttachmentIds, rewrite.stagingPaths);
      return;
    }
    // Compacting (or deferred input): queue behind it — visible and recallable.
    // Slash-skill items steer like any queued input on Ctrl-S (the activation
    // fires into the running turn instead of the literal text) — see
    // editor-keyboard.ts.
    // A running turn queues the activation too: every skill behaves like
    // plain input — queued by default, steered on demand — because the engine
    // steers activations into a running turn exactly like a steered user
    // message (v2 `prompt.inject`, v1 `SkillManager.recordActivation`).
    // The rewritten args reference the staging cache copies by plain path,
    // never the daemon uploads, so queueing takes recall semantics: the
    // retains are consumed and the copies retire to session lifetime — they
    // must stay readable until the item drains.
    const turnRunning = this.host.state.appState.streamingPhase !== 'idle';
    if (this.host.deferUserMessages || this.host.state.appState.isCompacting || turnRunning) {
      const args = rewrite.text.trim();
      this.host.state.queuedMessages.push({
        text: `/${skillName}${args.length > 0 ? ` ${args}` : ''}`,
        agentId: this.host.harness.interactiveAgentId,
        mode: 'skill',
        skillName,
        skillArgs: rewrite.text,
      });
      this.staging.releaseRecalled([...rewrite.imageAttachmentIds], rewrite.stagingPaths);
      this.host.track('input_queue');
      this.host.updateQueueDisplay();
      this.host.state.ui.requestRender();
      return;
    }
    const stagingLease = this.staging.create(
      [...new Set(rewrite.imageAttachmentIds)],
      rewrite.stagingPaths,
      'skill_activation',
    );
    this.beginSessionRequest();
    this.staging.trackDispatch(
      stagingLease,
      session.activateSkill(skillName, rewrite.text),
      (error) => {
        this.failSessionRequest(`Skill "${skillName}" failed: ${formatErrorMessage(error)}`);
      },
    );
  }

  activatePluginCommand(
    session: Session,
    pluginId: string,
    commandName: string,
    args: string,
  ): void {
    // Plugin command args are expanded verbatim (no XML escaping), so the
    // standard <image|video path> tag convention works — see
    // sendSkillActivation for the escaped-channel variant.
    let rewrite: ReturnType<typeof rewriteMediaPlaceholders>;
    try {
      rewrite = rewriteMediaPlaceholders(args, this.imageStore, 'tag');
    } catch (error) {
      this.host.showError(
        t('tui.statusMessages.failedToPrepareMediaAttachment', {
          error: formatErrorMessage(error),
        }),
      );
      return;
    }
    const stagingLease = this.staging.create(
      [...new Set(rewrite.imageAttachmentIds)],
      rewrite.stagingPaths,
      'plugin_command',
    );
    if (!this.validateMediaCapabilities(rewrite)) {
      this.staging.release(stagingLease);
      return;
    }
    this.beginSessionRequest();
    this.staging.trackDispatch(
      stagingLease,
      session.activatePluginCommand(pluginId, commandName, rewrite.text),
      (error) => {
        this.failSessionRequest(
          `Command "${pluginId}:${commandName}" failed: ${formatErrorMessage(error)}`,
        );
      },
    );
  }

  private sendMessage(session: Session, input: string, options?: SendMessageOptions): void {
    // Submission order must survive a mid-turn compaction: objectives queued
    // while compacting stay queued when the turn outlives the compaction, so
    // steering this input ahead of them would reorder the conversation.
    // Prompt-only backlog rides along in the same steer batch, ahead of the
    // new input; a non-steerable backlog (bash, slash-skill, inline-skill
    // bundle) cannot, and then this input queues behind it instead.
    if (
      this.canSteerQueueIntoRunningTurn() &&
      this.host.state.queuedMessages.every(isSteerableQueuedMessage)
    ) {
      // Same lease hand-off as the queue path below: the pre-dispatch lease
      // defers to the raw ids on the queue item, which re-leases inside
      // steerMessage and binds to the running turn.
      this.staging.defer(options?.lease);
      this.host.state.queuedMessages.push(this.toQueuedMessage(input, options));
      this.host.updateQueueDisplay();
      this.steerQueuedMessagesIntoRunningTurn();
      return;
    }
    if (
      this.host.deferUserMessages ||
      this.steeringQueuedMessages.size > 0 ||
      this.host.state.appState.streamingPhase !== 'idle' ||
      this.host.state.appState.isCompacting
    ) {
      // A queued message re-leases its staged media at dequeue dispatch; the
      // pre-dispatch lease defers to the queue item's raw ids.
      this.staging.defer(options?.lease);
      this.enqueueMessage(input, options);
      return;
    }
    this.sendMessageInternal(session, input, options);
  }

  // Tower mode keeps the main agent as a long-lived coordinator: while its
  // turn is live, input steers into that turn instead of queueing behind it,
  // so consecutive /tower objectives are accepted immediately rather than
  // serialized one turn at a time. A running WaitFor steers the same way: the
  // steer ends the wait at once and the model reads the new input, instead of
  // the input queueing until the wait times out. A foreground shell command
  // ('shell') has no turn to steer into and keeps queue semantics, as do
  // input deferral and compaction.
  private canSteerQueueIntoRunningTurn(): boolean {
    const phase = this.host.state.appState.streamingPhase;
    return (
      (this.host.state.appState.towerMode || this.host.streamingUI.isWaitForRunning()) &&
      phase !== 'idle' &&
      phase !== 'shell' &&
      !this.host.deferUserMessages &&
      !this.host.state.appState.isCompacting
    );
  }

  /** Steers the queue into the running turn. `manual` (Ctrl-S) skips bash items
   *  and sends each inline-skill bundle as its own group, so a grouped
   *  submission is never spliced around; the automatic path requires the whole
   *  queue to be steerable before it moves anything. */
  steerQueuedMessagesIntoRunningTurn(manual = false): void {
    const session = this.host.session;
    if (session === undefined || this.steeringQueuedMessages.size > 0) return;
    if (manual ? !this.canManuallySteer() : !this.canSteerQueueIntoRunningTurn()) return;
    const batch = manual
      ? this.host.state.queuedMessages.filter((message) => message.mode !== 'bash')
      : [...this.host.state.queuedMessages];
    if (batch.length === 0 || (!manual && !batch.every(isSteerableQueuedMessage))) return;
    const pending = [...batch];
    const sendNext = (): void => {
      if (this.host.deferUserMessages || this.host.state.appState.isCompacting) return;
      let first = pending.shift();
      while (first !== undefined && !this.host.state.queuedMessages.includes(first)) {
        first = pending.shift();
      }
      if (first === undefined) {
        this.host.updateQueueDisplay();
        if (!manual && this.canSteerQueueIntoRunningTurn()) {
          this.steerQueuedMessagesIntoRunningTurn();
        } else {
          this.drainQueueIfIdle();
        }
        return;
      }
      // An inline-skill bundle steers as its own group so its prompt and its
      // activations reach the model together; plain items coalesce into one
      // run while no bundle separates them.
      const group = [first];
      if (first.inlineSkillActivations === undefined) {
        while (pending[0] !== undefined && pending[0].inlineSkillActivations === undefined) {
          const next = pending.shift()!;
          if (this.host.state.queuedMessages.includes(next)) group.push(next);
        }
      }
      for (const message of group) this.steeringQueuedMessages.add(message);
      this.host.updateQueueDisplay();
      const items = group.map((message) => {
        const item = toSteerInputItem(message);
        if (message.parts === undefined) return item;
        return {
          ...item,
          parts: refreshExpiringImageFileRefs(
            message.parts,
            message.imageAttachmentIds ?? [],
            this.imageStore,
          ),
        };
      });
      this.steerMessage(
        session,
        items,
        (steered) => {
          for (const message of group) this.steeringQueuedMessages.delete(message);
          if (this.host.session !== session) return;
          if (steered || manual) {
            const done = new Set(group);
            this.host.state.queuedMessages = this.host.state.queuedMessages.filter(
              (message) => !done.has(message),
            );
          }
          if (!steered) {
            this.staging.releaseQueued(
              group.filter((message) => !this.host.state.queuedMessages.includes(message)),
            );
          }
          this.host.updateQueueDisplay();
          if (steered || manual) {
            sendNext();
            return;
          }
          // A turn that ended while the steer was in flight could not drain
          // the held queue. A prompt dispatched now while the engine still runs
          // a turn launched by the steer is queued behind it by the engine, so
          // the order holds either way.
          this.drainQueueIfIdle();
        },
        manual,
      );
    };
    sendNext();
  }

  canManuallySteer(): boolean {
    const phase = this.host.state.appState.streamingPhase;
    return (
      !this.host.deferUserMessages &&
      !this.host.state.appState.isCompacting &&
      phase !== 'idle' &&
      phase !== 'shell' &&
      this.steeringQueuedMessages.size === 0
    );
  }

  isSteeringQueuedMessages(): boolean {
    return this.steeringQueuedMessages.size > 0;
  }

  /** A queue discard must not release media owned by an in-flight steer. */
  isSteeringQueuedMessage(message: QueuedMessage): boolean {
    return this.steeringQueuedMessages.has(message);
  }

  private drainQueueIfIdle(): void {
    if (
      this.host.state.appState.streamingPhase !== 'idle' ||
      this.host.deferUserMessages ||
      this.host.state.appState.isCompacting ||
      this.host.state.queuedMessageDispatchPending
    ) {
      return;
    }
    this.drainOneQueuedMessage();
  }

  drainOneQueuedMessage(): void {
    const session = this.host.session;
    if (session === undefined) return;
    const item = this.shiftQueuedMessage();
    if (item === undefined) return;
    if (item.mode === 'bash') {
      this.staging.releaseQueued([item]);
      void this.host.runShellCommandFromInput(item.text);
    } else {
      this.sendQueuedMessage(session, item);
    }
    this.host.updateQueueDisplay();
  }

  shiftQueuedMessage(): QueuedMessage | undefined {
    if (this.host.state.queuedMessages.length === 0) return undefined;
    const [first, ...rest] = this.host.state.queuedMessages;
    if (this.steeringQueuedMessages.has(first!)) return undefined;
    this.host.state.queuedMessages = rest;
    return first;
  }

  steerMessage(
    session: Session,
    input: readonly SteerInputItem[],
    onSettled?: (steered: boolean) => void,
    manual = false,
  ): void {
    if (this.host.deferUserMessages || this.host.state.appState.isCompacting) {
      if (onSettled !== undefined) {
        onSettled(false);
      } else {
        for (const item of input) this.enqueueMessage(item.text, item);
      }
      return;
    }
    const activations = input.flatMap((item) => item.inlineSkillActivations ?? []);
    let prepared: PreparedSkillActivations | undefined;
    let resolvedInput: readonly SteerInputItem[];
    try {
      if (activations.length > 0) {
        prepared = this.host.prepareSkillActivations(
          activations,
          input.some((item) => item.mediaSnapshots !== undefined)
            ? input.flatMap((item) => item.mediaSnapshots ?? [])
            : undefined,
        );
      }
      resolvedInput = input.map((item) =>
        item.parts === undefined
          ? item
          : {
              ...item,
              parts: resolveOriginalCaptions(
                prepared === undefined
                  ? item.parts
                  : omitExpiredVideoFileRefs(item.parts, prepared.cachedVideos),
                item.imageAttachmentIds ?? [],
                this.imageStore,
                originalsDirForSession(session),
              ),
            },
      );
    } catch (error) {
      if (prepared !== undefined) this.host.releaseSkillArgumentMedia(prepared);
      this.host.showError(
        t('tui.statusMessages.failedToPrepareMediaAttachment', {
          error: formatErrorMessage(error),
        }),
      );
      onSettled?.(false);
      return;
    }
    const startsNewTurn = this.host.state.appState.streamingPhase === 'idle';
    if (startsNewTurn) this.beginSessionRequest();
    const steeredEntries: TranscriptEntry[] = input.map((item) => ({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: item.text,
      skillNames: item.inlineSkillActivations?.map((activation) => activation.skillName),
      imageAttachmentIds: nonEmptyIds(item.imageAttachmentIds),
    }));
    for (const entry of steeredEntries) this.host.appendTranscriptEntry(entry);

    // Dedupe per item, not across the batch: each queued message retained a
    // shared medium once, so the batch's id multiplicity is the retain count.
    // A skill arg rewrite retains its own ids, so `prepared`'s stay additive.
    const mediaAttachmentIds = input.flatMap((item) => [
      ...new Set([...(item.imageAttachmentIds ?? []), ...(item.videoAttachmentIds ?? [])]),
    ]);
    const stagingLease = this.staging.create(
      [...mediaAttachmentIds, ...(prepared?.mediaAttachmentIds ?? [])],
      prepared?.stagingPaths ?? [],
      'user',
    );
    const currentTurnId = this.host.streamingUI.getTurnContext().turnId;
    // Skill steers may not merge into the current turn: an untracked active
    // turn (e.g. a goal continuation) has no steerable prompt, so the engine
    // queues the submission — and binding the lease here would release its
    // media when that unrelated turn ends. Leave skill leases unclaimed so
    // the submission's own turn.started claims them; a merged steer simply
    // retires its media at session close instead.
    if (currentTurnId !== undefined && prepared === undefined) {
      this.staging.bindToTurn(stagingLease, currentTurnId);
    }
    const request =
      prepared === undefined
        ? session.steer(combineSteerInput(resolvedInput))
        : session.promptWithSkills(combineSteerInput(resolvedInput), prepared.skills, {
            steerIfActive: true,
          });
    if (onSettled !== undefined) {
      void request.then(
        () => onSettled(true),
        () => {},
      );
    }
    this.staging.trackDispatch(stagingLease, request, (error) => {
      if (this.host.session !== session) {
        onSettled?.(false);
        return;
      }
      const message = t('tui.statusMessages.failedToSteer', {
        error: formatErrorMessage(error),
      });
      if (startsNewTurn && this.host.streamingUI.getTurnContext().turnId === undefined) {
        this.failSessionRequest(message);
      } else {
        this.host.showError(message);
      }
      if (onSettled !== undefined) {
        this.staging.defer(stagingLease);
        if (prepared !== undefined) this.host.releaseSkillArgumentMedia(prepared);
        if (prepared === undefined && !manual) this.removeTranscriptEntries(steeredEntries);
        onSettled(false);
      }
    });
  }

  trackPendingEntries(
    entries: readonly TranscriptEntry[],
    request: Promise<void>,
  ): Promise<void> {
    for (const entry of entries) this.pendingPromptEntries.add(entry);
    const settle = (): void => {
      for (const entry of entries) this.pendingPromptEntries.delete(entry);
    };
    void request.then(settle, settle);
    return request;
  }

  hasPendingPromptEntry(entry: TranscriptEntry): boolean {
    return this.pendingPromptEntries.has(entry);
  }

  handlePromptConflict(args: {
    session: Session;
    error: unknown;
    entries?: readonly TranscriptEntry[];
    retried?: boolean;
    retry: () => void;
    restore: () => void;
  }): boolean {
    const { session, error, entries, retried = false, retry, restore } = args;
    if (this.host.session?.id !== session.id || !isSessionOccupiedError(error)) return false;
    if (entries !== undefined) this.host.removeTranscriptEntries(entries);
    this.host.setAppState({ streamingPhase: 'idle' });
    this.host.resetLivePane();
    this.host.showSessionOccupancyPrompt({ session, error, retried, retry, restore });
    return true;
  }

  private removeTranscriptEntries(entries: readonly TranscriptEntry[]): void {
    this.host.removeTranscriptEntries(entries);
  }
}

function isSteerableQueuedMessage(message: QueuedMessage): boolean {
  return (
    message.inlineSkillActivations === undefined &&
    message.mode !== 'bash' &&
    message.mode !== 'skill'
  );
}

function toSteerInputItem(message: QueuedMessage): SteerInputItem {
  return {
    text: message.text,
    parts: message.parts,
    imageAttachmentIds: message.imageAttachmentIds,
    videoAttachmentIds: message.videoAttachmentIds,
    mediaSnapshots: message.mediaSnapshots,
    inlineSkillActivations: message.inlineSkillActivations,
  };
}
