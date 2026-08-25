/**
 * TUI2 `/undo` command — transcript + session history rollback.
 *
 * Mirrors `tui/commands/undo.ts` with the pi-tui component-tree operations
 * replaced by response-store transcript-array operations, and the
 * `UndoSelectorComponent` mounting replaced by store dialog state
 * (`activeDialog: 'undo-selector'` + `undoChoices`).
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { ContextMessage } from '@moonshot-ai/kimi-code-sdk';
import { isKimiError } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import { getNoActiveSessionMessage } from '../constant/kimi-tui';
import type { TranscriptEntry } from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import { nextTranscriptId } from '../utils/transcript-id';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Undo command
// ---------------------------------------------------------------------------

interface UndoAvailability {
  readonly maxCount: number;
  readonly stoppedAtCompaction: boolean;
}

type UndoSessionContext = Awaited<
  ReturnType<NonNullable<SlashCommandHost['session']>['getContext']>
>;

const UNDO_LIMIT_STATUS_TURN_ID = 'undo-limit-status';

export async function handleUndoCommand(host: SlashCommandHost, args: string = ''): Promise<void> {
  if (host.state.appState.streamingPhase !== 'idle') {
    host.showError(t('tui.statusMessages.undoCannotWhileStreaming'));
    return;
  }

  const trimmed = args.trim();
  if (trimmed.length === 0) {
    await showUndoSelector(host);
    return;
  }

  const count = parseUndoCount(trimmed);
  if (count === undefined) {
    host.showError(t('tui.statusMessages.undoUsage'));
    return;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }

  const availability = await resolveUndoAvailability(host);
  if (count > availability.maxCount) {
    showUndoLimitStatus(host, formatUndoLimitMessage(count, availability));
    return;
  }

  await undoByCount(host, count);
}

async function undoByCount(host: SlashCommandHost, count: number): Promise<boolean> {
  const session = host.session;
  if (session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return false;
  }

  const entries = host.store?.state.transcript ?? host.state.transcriptEntries;
  const lastUserIndex = findUndoAnchorEntryIndex(entries, count);
  if (lastUserIndex === undefined) {
    showUndoLimitStatus(host, t('tui.statusMessages.undoNothingToUndo'));
    return false;
  }

  try {
    await session.undoHistory(count);
  } catch (error) {
    const limit = undoLimitFromError(error);
    if (limit !== undefined) {
      showUndoLimitStatus(host, formatUndoLimitMessage(limit.requestedCount, limit));
      return false;
    }
    const message = formatErrorMessage(error);
    host.showError(t('tui.statusMessages.undoFailed', { message }));
    return false;
  }
  host.noteContextCut?.();

  const preservedEntries = entries
    .slice(lastUserIndex)
    .filter((entry) => !isUndoContextEntry(entry));
  if (host.store !== undefined) {
    host.store.setState('transcript', [
      ...entries.slice(0, lastUserIndex),
      ...preservedEntries,
    ]);
  } else {
    host.state.transcriptEntries.splice(
      lastUserIndex,
      host.state.transcriptEntries.length - lastUserIndex,
      ...preservedEntries,
    );
  }

  if (entries.length === 0) {
    renderWelcome(host);
  }

  return true;
}

async function showUndoSelector(host: SlashCommandHost): Promise<void> {
  if (host.session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }

  const availability = await resolveUndoAvailability(host);
  const choices = createUndoChoices(host.store?.state.transcript ?? host.state.transcriptEntries, availability.maxCount);
  if (choices.length === 0) {
    showUndoLimitStatus(host, formatNothingToUndoMessage(availability));
    return;
  }

  // tui2: the undo selector renders from store dialog state; the choice is
  // resolved through the shell's undo-selector dialog.
  host.store?.setState('activeDialog', 'undo-selector');
  host.store?.setState('undoChoices', choices);
}

/** Resolve the open undo selector (called by the undo-selector dialog). */
export function resolveUndoSelectorChoice(
  host: SlashCommandHost,
  choice: { readonly count: number; readonly input: string } | null,
): void {
  host.store?.setState('activeDialog', null);
  host.store?.setState('undoChoices', undefined);
  if (choice === null) {
    host.restoreEditor();
    return;
  }
  void undoByCount(host, choice.count).then((undone) => {
    if (undone) {
      host.restoreInputText(choice.input);
      return;
    }
    host.restoreEditor();
  });
}

function parseUndoCount(args: string): number | undefined {
  const value = args.trim();
  if (value.length === 0) return 1;
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}

async function resolveUndoAvailability(host: SlashCommandHost): Promise<UndoAvailability> {
  const local = undoAvailabilityFromTranscript(host.store?.state.transcript ?? host.state.transcriptEntries);
  const context = await getSessionContext(host.session);
  if (context === undefined) return local;

  const activeContext = undoAvailabilityFromContext(context.history);
  return {
    maxCount: Math.min(local.maxCount, activeContext.maxCount),
    stoppedAtCompaction: local.stoppedAtCompaction || activeContext.stoppedAtCompaction,
  };
}

async function getSessionContext(
  session: SlashCommandHost['session'],
): Promise<UndoSessionContext | undefined> {
  const getContext = (session as { getContext?: () => Promise<UndoSessionContext> } | undefined)
    ?.getContext;
  if (session === undefined || getContext === undefined) return undefined;
  try {
    return await getContext.call(session);
  } catch {
    return undefined;
  }
}

function undoAvailabilityFromTranscript(entries: readonly TranscriptEntry[]): UndoAvailability {
  const { anchors, stoppedAtCompaction } = activeUndoAnchorEntries(entries);
  return {
    maxCount: anchors.length,
    stoppedAtCompaction,
  };
}

function undoAvailabilityFromContext(history: readonly ContextMessage[]): UndoAvailability {
  let maxCount = 0;
  let stoppedAtCompaction = false;

  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message === undefined) continue;
    if (message.origin?.kind === 'injection') continue;
    if (message.origin?.kind === 'compaction_summary') {
      stoppedAtCompaction = true;
      break;
    }
    if (isContextUndoAnchor(message)) maxCount++;
  }

  return { maxCount, stoppedAtCompaction };
}

function isContextUndoAnchor(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  if (origin.kind === 'skill_activation') {
    return origin.trigger === 'user-slash';
  }
  if (origin.kind === 'plugin_command') {
    return origin.trigger === 'user-slash';
  }
  return false;
}

function createUndoChoices(
  entries: readonly TranscriptEntry[],
  maxCount: number,
): readonly { id: string; count: number; input: string; label: string }[] {
  if (maxCount <= 0) return [];
  const anchors = activeUndoAnchorEntries(entries).anchors.slice(-maxCount);
  return anchors.map((entry, index) => ({
    id: entry.id,
    count: anchors.length - index,
    input: formatUndoChoiceInput(entry),
    label: formatUndoChoiceLabel(entry),
  }));
}

function activeUndoAnchorEntries(
  entries: readonly TranscriptEntry[],
): { readonly anchors: readonly TranscriptEntry[]; readonly stoppedAtCompaction: boolean } {
  const lastCompactionEntryIndex = entries.findLastIndex(
    (entry) => entry.compactionData !== undefined,
  );
  const activeEntries =
    lastCompactionEntryIndex >= 0 ? entries.slice(lastCompactionEntryIndex + 1) : entries;
  return {
    anchors: activeEntries.filter(isUndoAnchorEntry),
    stoppedAtCompaction: lastCompactionEntryIndex >= 0,
  };
}

function formatUndoChoiceLabel(entry: TranscriptEntry): string {
  if (entry.kind === 'skill_activation') {
    const name = singleLine(entry.skillName ?? entry.content.replace(/^Activated skill:\s*/, ''));
    const args = singleLine(entry.skillArgs ?? '');
    if (name.length === 0) return t('tui.statusMessages.undoSkillUnknown');
    return args.length > 0 ? `/${name} ${args}` : `/${name}`;
  }
  if (entry.kind === 'plugin_command' && entry.pluginCommandData !== undefined) {
    return (
      formatPluginCommandSlash(entry.pluginCommandData) ?? t('tui.statusMessages.undoUserMessage')
    );
  }

  const content = singleLine(entry.content);
  const imageCount = entry.imageAttachmentIds?.length ?? 0;
  if (content.length > 0) return content;
  if (imageCount > 0) {
    return t('tui.statusMessages.undoUserMessageWithImage', { count: imageCount });
  }
  return t('tui.statusMessages.undoUserMessage');
}

function formatUndoChoiceInput(entry: TranscriptEntry): string {
  if (entry.kind === 'skill_activation') {
    const name = singleLine(entry.skillName ?? entry.content.replace(/^Activated skill:\s*/, ''));
    const args = singleLine(entry.skillArgs ?? '');
    if (name.length === 0) return '';
    return args.length > 0 ? `/${name} ${args}` : `/${name}`;
  }
  if (entry.kind === 'plugin_command' && entry.pluginCommandData !== undefined) {
    return formatPluginCommandSlash(entry.pluginCommandData) ?? entry.content;
  }
  return entry.content;
}

function formatPluginCommandSlash(
  data: NonNullable<TranscriptEntry['pluginCommandData']>,
): string | undefined {
  const name = `${data.pluginId}:${data.commandName}`;
  const args = singleLine(data.args ?? '');
  if (name.length === 0) return undefined;
  return args.length > 0 ? `/${name} ${args}` : `/${name}`;
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function formatUndoLimitMessage(requestedCount: number, availability: UndoAvailability): string {
  const reason = availability.stoppedAtCompaction
    ? t('tui.statusMessages.undoLimitAfterCompaction')
    : '';
  return t('tui.statusMessages.undoLimit', {
    requested: String(requestedCount),
    max: String(availability.maxCount),
    reason,
  });
}

function formatNothingToUndoMessage(availability: UndoAvailability): string {
  if (availability.stoppedAtCompaction) {
    return t('tui.statusMessages.undoNothingToUndoAfterCompaction');
  }
  return t('tui.statusMessages.undoNothingToUndo');
}

function showUndoLimitStatus(host: SlashCommandHost, message: string): void {
  host.appendTranscriptEntry({
    id: nextTranscriptId(),
    kind: 'status',
    turnId: UNDO_LIMIT_STATUS_TURN_ID,
    renderMode: 'plain',
    content: message,
  });
}

function undoLimitFromError(
  error: unknown,
): (UndoAvailability & { readonly requestedCount: number }) | undefined {
  if (!isKimiError(error)) return undefined;
  const details = error.details;
  if (details?.['reason'] !== 'undo_limit') return undefined;
  const requestedCount = details['requestedCount'];
  const maxCount = details['undoableCount'];
  const stoppedAtCompaction = details['stoppedAtCompaction'];
  if (
    typeof requestedCount !== 'number' ||
    typeof maxCount !== 'number' ||
    typeof stoppedAtCompaction !== 'boolean'
  ) {
    return undefined;
  }
  return { requestedCount, maxCount, stoppedAtCompaction };
}

function isUndoAnchorEntry(entry: TranscriptEntry): boolean {
  return (
    entry.kind === 'user' ||
    (entry.kind === 'skill_activation' && entry.skillTrigger === 'user-slash') ||
    entry.kind === 'plugin_command'
  );
}

function findUndoAnchorEntryIndex(
  entries: readonly TranscriptEntry[],
  count: number,
): number | undefined {
  let found = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry !== undefined && isUndoAnchorEntry(entry)) {
      found++;
      if (found === count) return i;
    }
  }
  return undefined;
}

function isUndoContextEntry(entry: TranscriptEntry): boolean {
  switch (entry.kind) {
    case 'user':
    case 'assistant':
    case 'tool_call':
    case 'thinking':
    case 'skill_activation':
    case 'plugin_command':
    case 'cron':
      return true;
    case 'status':
    case 'goal':
      return entry.turnId !== undefined;
    case 'welcome':
      return false;
  }
}

function renderWelcome(host: SlashCommandHost): void {
  const entries = host.store?.state.transcript ?? host.state.transcriptEntries;
  if (entries.some((entry) => entry.kind === 'welcome')) {
    return;
  }
  host.appendTranscriptEntry({
    id: nextTranscriptId(),
    kind: 'welcome',
    renderMode: 'plain',
    content: '',
  });
}
