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
  QueuedMessage,
  SteerInputItem,
  TranscriptEntry,
} from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import type { ImageAttachmentStore } from '../utils/image-attachment-store';
import {
  extractMediaAttachments,
  originalsDirForSession,
  pendingMediaIngestions,
  refreshExpiringImageFileRefs,
  resolveOriginalCaptions,
  rewriteMediaPlaceholders,
} from '../utils/image-placeholder';
import type { ExtractionResult } from '../utils/image-placeholder';
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
  showError(message: string): void;
  updateQueueDisplay(): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  setAppState(patch: Partial<AppState>): void;
  runShellCommandFromInput(command: string): Promise<void>;
  track(event: string, properties?: Parameters<KimiHarness['track']>[1]): void;
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
      // ingestion (compression/daemon upload) is awaited inside it.
      extraction =
        preExtracted ??
        (await extractMediaAttachments(
          text,
          this.imageStore,
          (attachment, bytes, mime, width, height) =>
            this.host.editorKeyboard.prepareImageAttachment(attachment, bytes, mime, width, height),
        ));
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
      this.host.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
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
    if (this.host.btwPanelController.sendUserInput(text)) return;
    if (this.host.state.appState.model.trim().length === 0) {
      this.host.showError(getLlmNotSetMessage());
      return;
    }
    let extraction: ExtractionResult;
    try {
      extraction =
        preExtracted ??
        (await extractMediaAttachments(
          text,
          this.imageStore,
          (attachment, bytes, mime, width, height) =>
            this.host.editorKeyboard.prepareImageAttachment(attachment, bytes, mime, width, height),
        ));
    } catch (error) {
      this.host.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
      return;
    }
    if (!this.validateMediaCapabilities(extraction)) return;
    if (this.host.cacheHint.maybeInterceptOnSubmit(text, extraction)) return;
    let session = this.host.session;
    if (session === undefined) {
      // Dispatch only routes here on the v2 engine, so the session is created
      // lazily on first use exactly like a normal prompt.
      session = await this.host.ensureSession();
      if (session === undefined) return;
    }
    if (
      this.host.deferUserMessages ||
      this.host.state.appState.goal?.status === 'active' ||
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
        this.failSessionRequest(`Skill activation failed: ${formatErrorMessage(error)}`);
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
    await session.promptWithSkills(
      extraction.hasMedia
        ? resolveOriginalCaptions(
            extraction.parts,
            extraction.imageAttachmentIds,
            this.imageStore,
            originalsDirForSession(session),
          )
        : text,
      activations.map((activation) => ({ name: activation.skillName, args: activation.args })),
    );
    // The engine bundles the activations into the prompt's own message, and
    // the `skill.activated` events land synchronously during the call — so
    // the cards appended for this submission are the skill_activation entries
    // with fresh ids (the window trim may replace the entries array mid-call,
    // so membership is decided by id, not by index into a captured array).
    // Appending the user entry afterwards keeps the live transcript in the
    // same order as a resumed replay (skill cards first, prompt last).
    // Marking only happens once the submission was accepted: a rejected
    // bundle leaves no cards and must not leave a local undo anchor the
    // engine never recorded.
    for (const entry of this.host.state.transcriptEntries) {
      if (entry.kind === 'skill_activation' && !knownEntryIds.has(entry.id)) {
        entry.bundledWithPrompt = true;
      }
    }
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: text,
      imageAttachmentIds:
        extraction.imageAttachmentIds.length > 0 ? extraction.imageAttachmentIds : undefined,
    });
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
    this.host.state.queuedMessages.push({
      text,
      agentId: this.host.harness.interactiveAgentId,
      parts: options?.parts,
      imageAttachmentIds: nonEmptyIds(options?.imageAttachmentIds),
      videoAttachmentIds: nonEmptyIds(options?.videoAttachmentIds),
      mode,
      inlineSkillActivations: options?.inlineSkillActivations,
    });
    this.host.track('input_queue');
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
        this.failSessionRequest(`Skill activation failed: ${formatErrorMessage(error)}`);
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
        this.failSessionRequest(`Failed to steer: ${formatErrorMessage(error)}`);
      });
      return;
    }
    this.staging.trackDispatch(
      stagingLease,
      session.prompt(sdkInput, { promptId: submissionId }),
      (error) => {
        this.failSessionRequest(`Failed to send: ${formatErrorMessage(error)}`);
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
      this.host.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
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
      this.host.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
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
    const phase = this.host.state.appState.streamingPhase;
    // Tower mode keeps the main agent as a long-lived coordinator: while its
    // turn is live, new input steers into that turn instead of queueing
    // behind it, so consecutive /tower objectives are accepted immediately
    // rather than serialized one turn at a time. A foreground shell command
    // ('shell') has no turn to steer into and keeps queue semantics, as do
    // input deferral and compaction.
    const steerIntoCoordinator =
      this.host.state.appState.towerMode &&
      phase !== 'idle' &&
      phase !== 'shell' &&
      !this.host.deferUserMessages &&
      !this.host.state.appState.isCompacting;
    // Submission order must survive a mid-turn compaction: objectives queued
    // while compacting stay queued when the turn outlives the compaction, so
    // steering this input ahead of them would reorder the conversation.
    // Prompt-only backlog rides along in the same steer batch, ahead of the
    // new input; a non-steerable backlog (bash, slash-skill, inline-skill
    // bundle) cannot, and then this input queues behind it instead.
    const backlog = this.host.state.queuedMessages;
    const backlogSteerable = backlog.every(
      (m) => m.inlineSkillActivations === undefined && m.mode !== 'bash' && m.mode !== 'skill',
    );
    if (steerIntoCoordinator && backlogSteerable) {
      // Same lease hand-off as the queue path below: the pre-dispatch lease
      // defers to the raw ids on the steer item, which re-leases inside
      // steerMessage and binds to the running turn.
      this.staging.defer(options?.lease);
      const items: SteerInputItem[] = [
        ...backlog.map((m) => ({
          text: m.text,
          parts: m.parts,
          imageAttachmentIds: m.imageAttachmentIds,
          videoAttachmentIds: m.videoAttachmentIds,
        })),
        {
          text: input,
          parts: options?.parts,
          imageAttachmentIds: options?.imageAttachmentIds,
          videoAttachmentIds: options?.videoAttachmentIds,
        },
      ];
      if (backlog.length > 0) {
        this.host.state.queuedMessages = [];
        this.host.updateQueueDisplay();
      }
      this.steerMessage(session, items);
      return;
    }
    if (
      this.host.deferUserMessages ||
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

  steerMessage(session: Session, input: readonly SteerInputItem[]): void {
    if (this.host.deferUserMessages || this.host.state.appState.isCompacting) {
      for (const item of input) {
        this.enqueueMessage(item.text, item);
      }
      return;
    }
    if (this.host.state.appState.streamingPhase === 'idle') {
      for (const item of input) {
        this.sendMessageInternal(session, item.text, item);
      }
      return;
    }

    for (const item of input) {
      this.host.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: 'user',
        turnId: this.host.streamingUI.getTurnContext().turnId,
        renderMode: 'plain',
        content: item.text,
        imageAttachmentIds: nonEmptyIds(item.imageAttachmentIds),
      });
    }

    // Dedupe per item, not across the batch: each queued message retained a
    // shared medium once, so the batch's id multiplicity is the retain count.
    const mediaAttachmentIds = input.flatMap((item) => [
      ...new Set([...(item.imageAttachmentIds ?? []), ...(item.videoAttachmentIds ?? [])]),
    ]);
    const stagingLease = this.staging.create(mediaAttachmentIds, [], 'user');
    const currentTurnId = this.host.streamingUI.getTurnContext().turnId;
    if (currentTurnId !== undefined) this.staging.bindToTurn(stagingLease, currentTurnId);
    // Same dispatch-time caption resolution as sendMessageInternal — the
    // running turn's session owns the persisted originals.
    const resolvedInput = input.map((item) =>
      item.parts === undefined
        ? item
        : {
            ...item,
            parts: resolveOriginalCaptions(
              item.parts,
              item.imageAttachmentIds ?? [],
              this.imageStore,
              originalsDirForSession(session),
            ),
          },
    );
    this.staging.trackDispatch(
      stagingLease,
      session.steer(combineSteerInput(resolvedInput)),
      (error) => {
        this.host.showError(`Failed to steer: ${formatErrorMessage(error)}`);
      },
    );
  }
}
