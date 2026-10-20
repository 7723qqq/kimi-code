import type { Event, KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';
import { Spacer } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';

import { BtwPanelComponent } from '../components/panes/btw-panel';
import { getNoActiveSessionMessage } from '../constant/kimi-tui';
import { createMarkdownTheme } from '../theme/pi-tui-theme';
import type { TUIState } from '../tui-state';
import { formatErrorMessage } from '../utils/event-payload';
import { formatHookResultPlain } from '../utils/hook-result-format';
import type { InlineSkillActivation, PreparedSkillActivations } from '../types';
import { MEDIA_INGESTION_SUBMIT_WAIT_MS } from '../constant/media';
import type { ImageAttachmentStore } from '../utils/image-attachment-store';
import {
  extractMediaAttachments,
  originalsDirForSession,
  pendingMediaIngestions,
  resolveOriginalCaptions,
  type ExtractionResult,
} from '../utils/image-placeholder';
import type { StagingLease, StagingLeaseTracker } from './staging-leases';

export interface BtwPanelHost {
  state: TUIState;
  session: Session | undefined;
  readonly harness: KimiHarness;
  readonly skillCommandMap?: ReadonlyMap<string, string>;

  showError(msg: string): void;
  validateMediaCapabilities(extraction: ExtractionResult): boolean;
  prepareSkillActivations(activations: readonly InlineSkillActivation[]): PreparedSkillActivations;
  releaseSkillArgumentMedia(prepared: PreparedSkillActivations): void;
}

export class BtwPanelController {
  private active:
    | {
        readonly agentId: string;
        readonly panel: BtwPanelComponent;
      }
    | undefined;
  private readonly panelsByAgentId = new Map<string, BtwPanelComponent>();
  private readonly cancelledAgentIds = new Set<string>();

  constructor(
    private readonly host: BtwPanelHost,
    private readonly imageStore: ImageAttachmentStore,
    private readonly staging: StagingLeaseTracker,
  ) {}

  open(
    agentId: string,
    initialPrompt: string,
    inlineSkillActivations?: readonly InlineSkillActivation[],
  ): void {
    let panel: BtwPanelComponent;
    panel = new BtwPanelComponent({
      markdownTheme: createMarkdownTheme(),
      canUseScrollKeys: () => this.host.state.editor.getText().length === 0,
      terminalRows: () => this.host.state.terminal.rows,
      onPrompt: (prompt, inlineSkillActivations) => {
        this.promptAgent(agentId, prompt, panel, inlineSkillActivations);
      },
    });
    this.active = { agentId, panel };
    this.panelsByAgentId.set(agentId, panel);
    this.mount(panel);
    panel.submit(initialPrompt, inlineSkillActivations);
  }

  isActive(): boolean {
    return this.active !== undefined;
  }

  clear(): void {
    const active = this.active;
    if (active !== undefined && this.shouldCancelOnUnmount(active.panel)) {
      void this.cancelAgent(active.agentId);
    }
    this.active = undefined;
    this.panelsByAgentId.clear();
    this.host.state.btwPanelContainer.clear();
    this.host.state.editor.connectedAbove = false;
  }

  closeOrCancel(): boolean {
    const active = this.active;
    if (active === undefined) return false;
    const shouldCancel = this.shouldCancelOnUnmount(active.panel);
    this.close(active.panel);
    if (shouldCancel) {
      void this.cancelAgent(active.agentId);
    }
    return true;
  }

  cancelRunning(): boolean {
    const active = this.active;
    if (active === undefined || !active.panel.isRunning()) return false;
    this.cancelledAgentIds.add(active.agentId);
    void this.cancelAgent(active.agentId);
    return true;
  }

  sendUserInput(text: string, inlineSkillActivations?: readonly InlineSkillActivation[]): boolean {
    const active = this.active;
    if (active === undefined) return false;
    if (active.panel.isRunning()) {
      this.showBusyNotice(active, text);
      return true;
    }
    active.panel.submit(text, inlineSkillActivations);
    this.host.state.ui.setFocus(this.host.state.editor);
    this.host.state.ui.requestRender();
    return true;
  }

  scroll(direction: 'up' | 'down'): boolean {
    const panel = this.active?.panel;
    if (panel === undefined || !panel.scroll(direction)) return false;
    this.host.state.ui.requestRender();
    return true;
  }

  routeEvent(event: Event): boolean {
    if (event.type === 'turn.started') this.staging.handleTurnStarted(event, event.agentId);
    if (event.type === 'turn.ended') this.staging.handleTurnEnded(event, event.agentId);
    const panel = this.panelsByAgentId.get(event.agentId);
    if (panel === undefined) return false;

    switch (event.type) {
      case 'assistant.delta':
        panel.appendAnswer(event.delta);
        this.host.state.ui.requestRender();
        return true;
      case 'thinking.delta':
        panel.appendThinking(event.delta);
        this.host.state.ui.requestRender();
        return true;
      case 'hook.result':
        panel.appendAnswer(formatHookResultPlain(event));
        this.host.state.ui.requestRender();
        return true;
      case 'turn.ended':
        this.cancelledAgentIds.delete(event.agentId);
        if (event.reason === 'completed') {
          panel.markDone();
        } else {
          panel.markFailed(formatBtwTurnEnd(event));
        }
        this.host.state.ui.requestRender();
        return true;
      default:
        return true;
    }
  }

  private mount(panel: BtwPanelComponent): void {
    this.host.state.btwPanelContainer.clear();
    this.host.state.btwPanelContainer.addChild(new Spacer(1));
    this.host.state.btwPanelContainer.addChild(panel);
    this.host.state.editor.connectedAbove = true;
    this.host.state.ui.setFocus(this.host.state.editor);
    this.host.state.ui.requestRender();
  }

  private close(panel: BtwPanelComponent): void {
    if (!this.host.state.btwPanelContainer.children.includes(panel)) return;
    this.unregister(panel);
    this.host.state.btwPanelContainer.clear();
    this.host.state.editor.connectedAbove = false;
    this.host.state.ui.setFocus(this.host.state.editor);
    this.host.state.ui.requestRender(true);
  }

  private unregister(panel: BtwPanelComponent): void {
    for (const [agentId, candidate] of this.panelsByAgentId) {
      if (candidate === panel) {
        this.panelsByAgentId.delete(agentId);
        this.cancelledAgentIds.delete(agentId);
      }
    }
    if (this.active?.panel === panel) this.active = undefined;
  }

  private showBusyNotice(active: { readonly panel: BtwPanelComponent }, input: string): void {
    this.host.state.editor.setText(input);
    active.panel.addTransientNotice(t('tui.statusMessages.btwBusyNotice'));
    this.host.state.ui.requestRender();
  }

  private promptAgent(
    agentId: string,
    prompt: string,
    panel: BtwPanelComponent,
    inlineSkillActivations?: readonly InlineSkillActivation[],
  ): void {
    const session = this.host.session;
    if (session === undefined) {
      panel.markFailed(getNoActiveSessionMessage());
      this.host.state.ui.requestRender();
      return;
    }
    const send =
      inlineSkillActivations !== undefined && inlineSkillActivations.length > 0
        ? () => this.promptWithSkills(agentId, session, prompt, panel, inlineSkillActivations)
        : () => session.prompt(prompt);
    void this.withInteractiveAgent(agentId, send).catch((error: unknown) => {
      panel.markFailed(t('tui.messages.btwSendFailed', { error: formatErrorMessage(error) }));
      this.host.state.ui.requestRender();
    });
  }

  private async promptWithSkills(
    agentId: string,
    session: Session,
    prompt: string,
    panel: BtwPanelComponent,
    activations: readonly InlineSkillActivation[],
  ): Promise<void> {
    let extraction: ExtractionResult | undefined;
    let prepared: PreparedSkillActivations | undefined;
    let lease: StagingLease | undefined;
    try {
      const ingestionWait = pendingMediaIngestions(
        prompt, this.imageStore, MEDIA_INGESTION_SUBMIT_WAIT_MS,
      );
      if (ingestionWait !== undefined) await ingestionWait;
      // Ctrl-C during the media wait: no child turn existed for cancel() to
      // stop, so settle the question here instead of dispatching it anyway.
      if (this.cancelledAgentIds.delete(agentId)) {
        panel.markFailed(t('tui.statusMessages.btwInterrupted'));
        return;
      }
      if (
        this.host.session !== session ||
        this.panelsByAgentId.get(agentId) !== panel ||
        !panel.isRunning()
      ) return;
      extraction = await Promise.resolve(
        extractMediaAttachments(prompt, this.imageStore),
      );
      if (!this.host.validateMediaCapabilities(extraction)) {
        throw new Error(t('tui.statusMessages.btwMediaUnsupported'));
      }
      prepared = this.host.prepareSkillActivations(activations);
      const input = extraction.hasMedia
        ? resolveOriginalCaptions(
            extraction.parts, extraction.imageAttachmentIds, this.imageStore,
            originalsDirForSession(session),
          )
        : prompt;
      lease = this.staging.create(
        [
          ...new Set([...extraction.imageAttachmentIds, ...extraction.videoAttachmentIds]),
          ...prepared.mediaAttachmentIds,
        ],
        prepared.stagingPaths,
        'user',
        undefined,
        agentId,
      );
      const request = session.promptWithSkills(input, prepared.skills);
      this.staging.trackDispatch(lease, request, () => {});
      await request;
    } catch (error) {
      if (lease === undefined) {
        if (prepared !== undefined) this.host.releaseSkillArgumentMedia(prepared);
        if (extraction !== undefined) {
          this.staging.releaseMedia([...extraction.imageAttachmentIds, ...extraction.videoAttachmentIds], []);
        }
      }
      throw error;
    }
  }

  private async cancelAgent(agentId: string): Promise<void> {
    const session = this.host.session;
    if (session === undefined) return;
    await this.withInteractiveAgent(agentId, () => session.cancel()).catch((error: unknown) => {
      this.host.showError(t('tui.messages.btwCancelFailed', { error: formatErrorMessage(error) }));
    });
  }

  private shouldCancelOnUnmount(panel: BtwPanelComponent): boolean {
    return panel.isRunning() || panel.isEmpty();
  }

  private withInteractiveAgent<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    return this.host.harness.withInteractiveAgent(agentId, fn);
  }
}

function formatBtwTurnEnd(event: Extract<Event, { type: 'turn.ended' }>): string {
  if (event.reason === 'cancelled') {
    return t('tui.statusMessages.btwInterrupted');
  }
  if (event.error?.code === 'provider.filtered') {
    return t('tui.statusMessages.btwFiltered');
  }
  if (event.error !== undefined) {
    return `[${event.error.code}] ${event.error.message}`;
  }
  if (event.reason === 'blocked') {
    return t('tui.statusMessages.promptBlocked');
  }
  return t('tui.statusMessages.btwTurnEndedReason', { reason: event.reason });
}
