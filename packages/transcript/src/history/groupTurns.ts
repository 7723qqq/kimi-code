import { daemonFileRefFromPairingPart, parseDaemonFileRef } from '../contract/mediaRef';
import {
  HIDDEN_USER_ORIGINS,
  isUserSlashOrigin,
  mapTurnOrigin,
  MARKER_USER_ORIGINS,
  projectTranscriptUserOrigin,
  TURN_OPENING_SYSTEM_TRIGGERS,
} from '../contract/origin';
import type { TranscriptAttachment } from '../model/attachment';
import type { TranscriptFrame, TranscriptUserOrigin } from '../model/frame';
import type { TranscriptItem, TranscriptMarker } from '../model/item';
import type { StepTiming, StepUsage, TurnOrigin } from '../model/turn';
import type { AgentTranscriptSnapshot } from '../ops/operation';

export type HistoryMediaSource =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'base64'; readonly media_type: string; readonly data: string }
  | { readonly kind: 'file' | 'session_media'; readonly file_id: string };

export type NativeHistoryMediaSource =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'inline'; readonly mimeType: string; readonly data: string }
  | { readonly kind: 'file'; readonly id: string; readonly mimeType: string }
  | { readonly kind: 'store'; readonly ref: string };

export interface HistoryTextPartMeta {
  readonly source?: string;
  readonly contentType?: string;
  readonly activationId?: string;
  readonly [key: string]: unknown;
}

export type HistoryContentPart =
  | { readonly type: 'text'; readonly text: string; readonly meta?: HistoryTextPartMeta }
  | { readonly type: 'think'; readonly think: string; readonly hidden?: boolean }
  | {
      readonly type: 'image' | 'video' | 'audio';
      readonly source: HistoryMediaSource;
      readonly name?: string;
    }
  | {
      readonly type: 'image_url' | 'video_url' | 'audio_url';
      readonly source: NativeHistoryMediaSource;
      readonly name?: string;
    }
  | {
      readonly type: 'file';
      readonly file_id: string;
      readonly name: string;
      readonly media_type: string;
      readonly size: number;
    }
  | { readonly type: string };

const USER_PROMPT_SUBMIT_HOOK_SOURCE = 'user prompt submit hook';

export function isUserPromptSubmitHookPart(part: { readonly type: string }): boolean {
  return (
    part.type === 'text' &&
    (part as { readonly meta?: HistoryTextPartMeta }).meta?.source ===
      USER_PROMPT_SUBMIT_HOOK_SOURCE
  );
}

const SKILL_ACTIVATION_PART_SOURCE = 'skill activation';

export function isSkillActivationPart(part: { readonly type: string }): boolean {
  return (
    part.type === 'text' &&
    (part as { readonly meta?: HistoryTextPartMeta }).meta?.source === SKILL_ACTIVATION_PART_SOURCE
  );
}

function annotateBundledSkillParts<T extends { readonly type: string }>(
  content: readonly T[],
  bundledActivations: readonly BundledSkillActivation[],
): T[] {
  if (bundledActivations.length === 0 || content.some(isSkillActivationPart)) {
    return [...content];
  }
  let index = 0;
  return content.map((part) => {
    const activation = bundledActivations[index];
    if (
      activation !== undefined &&
      part.type === 'text' &&
      (part as { readonly meta?: HistoryTextPartMeta }).meta?.source === undefined
    ) {
      index += 1;
      return {
        ...part,
        meta: { source: SKILL_ACTIVATION_PART_SOURCE, activationId: activation.activationId },
      } as T;
    }
    return part;
  });
}

export function withoutUserPromptSubmitHookParts<T extends { readonly type: string }>(
  content: readonly T[],
): readonly T[] {
  if (!content.some(isUserPromptSubmitHookPart)) return content;
  return content.filter((part) => !isUserPromptSubmitHookPart(part));
}

const USER_PROMPT_HOOK_RESULT_WRAPPER_RE =
  /^<hook_result hook_event="UserPromptSubmit">\n([\s\S]*)\n<\/hook_result>$/;

function userPromptSubmitHookMarkerPayload(part: { readonly type: string }): {
  readonly hookEvent: string;
  readonly content: string;
} {
  const text = (part as { readonly text?: unknown }).text;
  const raw = typeof text === 'string' ? text : '';
  const match = USER_PROMPT_HOOK_RESULT_WRAPPER_RE.exec(raw);
  return { hookEvent: 'UserPromptSubmit', content: match?.[1] ?? raw };
}

export interface HistoryToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string | null;
}

export interface HistoryMessage {
  readonly id?: string;
  readonly role: string;
  readonly content?: readonly HistoryContentPart[];
  readonly toolCalls?: readonly HistoryToolCall[];
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly origin?: { readonly kind: string };
  readonly usage?: StepUsage;
  readonly llmTiming?: StepTiming;
}

interface TurnDraft {
  turnId: string;
  ordinal: number;
  triggerPromptId?: string;
  origin: TurnOrigin;
  prompt?: string;
  attachmentIds?: string[];
  steps: StepDraft[];
}

interface StepDraft {
  stepId: string;
  ordinal: number;
  frames: TranscriptFrame[];
  usage?: StepUsage;
  llmTiming?: StepTiming;
}

const FALLBACK_ORIGIN: TurnOrigin = { kind: 'other' };

export interface HistoryProjectionOptions {
  readonly taskOriginTurnTaskIds?: ReadonlySet<string>;
  readonly steeredContents?: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly steeredByMessageId?: ReadonlyMap<string, readonly string[]>;
  readonly turnPromptIds?: ReadonlySet<string>;
}

export interface HistoryMessageProjector {
  syncOptions(options?: HistoryProjectionOptions): void;
  add(message: HistoryMessage): void;
  result(): AgentTranscriptSnapshot;
}

function toolOutputOf(message: HistoryMessage): unknown {
  const output: HistoryContentPart[] = [];
  let hasDaemonMedia = false;
  for (const part of message.content ?? []) {
    if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
      output.push(part);
      continue;
    }
    if (part.type === 'image' || part.type === 'video') {
      if ('source' in part && (part.source as HistoryMediaSource).kind === 'session_media') {
        hasDaemonMedia = true;
        output.push(part);
      }
      continue;
    }
    const ref = daemonFileRefFromPairingPart(part);
    if (ref !== undefined) {
      hasDaemonMedia = true;
      output.push({
        type: ref.kind,
        source: { kind: 'session_media', file_id: ref.ref.fileId },
        name: ref.name,
      });
      continue;
    }
    if ((part.type === 'image_url' || part.type === 'video_url') && 'source' in part) {
      const native = part as {
        readonly type: 'image_url' | 'video_url';
        readonly source: NativeHistoryMediaSource;
        readonly name?: string;
      };
      if (native.source.kind === 'url') {
        const daemonRef = parseDaemonFileRef(native.source.url);
        if (daemonRef !== undefined) {
          hasDaemonMedia = true;
          output.push({
            type: native.type === 'image_url' ? 'image' : 'video',
            source: { kind: 'session_media', file_id: daemonRef.fileId },
            name: native.name,
          });
        }
      }
    }
  }
  return hasDaemonMedia ? output : textOf(message);
}

export function groupMessagesIntoSnapshot(
  messages: readonly HistoryMessage[],
  options?: HistoryProjectionOptions,
): AgentTranscriptSnapshot {
  const projector = createHistoryMessageProjector();
  projector.syncOptions(options);
  for (const message of messages) projector.add(message);
  return projector.result();
}

export function createHistoryMessageProjector(): HistoryMessageProjector {
  const items: TranscriptItem[] = [];
  const turnIndices = new Map<string, number>();
  const attachments: TranscriptAttachment[] = [];
  const steeredContents = new Map<string, Map<string, number>>();
  const consumedSteeredContents = new Map<string, Map<string, number>>();
  const steeredByMessageId = new Map<string, readonly string[]>();
  const consumedSteerMessageIds = new Set<string>();
  let options: HistoryProjectionOptions | undefined;
  let turn: TurnDraft | undefined;
  let pendingNotificationFrames: {
    text: string;
    taskId: string | undefined;
    attachmentIds?: string[];
    promptIds?: readonly string[];
    origin?: TranscriptUserOrigin;
    steered?: boolean;
  }[] = [];
  let nextOrdinal = 0;
  let markerCount = 0;

  const syncOptions = (next?: HistoryProjectionOptions): void => {
    options = next;
    steeredByMessageId.clear();
    for (const [id, promptIds] of next?.steeredByMessageId ?? []) {
      if (!consumedSteerMessageIds.has(id)) steeredByMessageId.set(id, promptIds);
    }
    steeredContents.clear();
    for (const [key, byKind] of next?.steeredContents ?? []) {
      for (const [kind, total] of byKind) {
        const consumed = consumedSteeredContents.get(key)?.get(kind) ?? 0;
        const remaining = total - consumed;
        if (remaining <= 0) continue;
        const target = steeredContents.get(key) ?? new Map<string, number>();
        target.set(kind, remaining);
        steeredContents.set(key, target);
      }
    }
  };

  const foldTurnOpeningInput = (
    message: HistoryMessage,
  ): { text: string; attachmentIds?: string[] } => {
    const parts = message.content ?? [];
    const ids: string[] = [];
    const texts: string[] = [];
    for (const part of parts) {
      if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
        texts.push(part.text);
        continue;
      }
      if (part.type === 'image' || part.type === 'video' || part.type === 'audio') {
        if (!('source' in part) || part.source === undefined) continue;
        const source = part.source as HistoryMediaSource;
        const entity: TranscriptAttachment = {
          attachmentId: `att_${attachments.length + 1}`,
          mediaType: source.kind === 'base64' ? source.media_type : `${part.type}/*`,
          name: part.name,
          source:
            source.kind === 'url'
              ? { kind: 'url', url: source.url }
              : source.kind === 'file' || source.kind === 'session_media'
                ? { kind: source.kind, fileId: source.file_id }
                : undefined,
        };
        attachments.push(entity);
        ids.push(entity.attachmentId);
        continue;
      }
      if (part.type === 'file' && 'file_id' in part) {
        const entity: TranscriptAttachment = {
          attachmentId: `att_${attachments.length + 1}`,
          mediaType: part.media_type as string,
          name: part.name as string,
          size: part.size as number,
          source: { kind: 'file', fileId: part.file_id as string },
        };
        attachments.push(entity);
        ids.push(entity.attachmentId);
        continue;
      }
      const ref = daemonFileRefFromPairingPart(part);
      if (ref !== undefined) {
        const entity: TranscriptAttachment = {
          attachmentId: `att_${attachments.length + 1}`,
          mediaType: `${ref.kind}/*`,
          name: ref.name,
          source: { kind: 'session_media', fileId: ref.ref.fileId },
        };
        attachments.push(entity);
        ids.push(entity.attachmentId);
      }
    }
    for (const attachment of originFileAttachments(message)) {
      const entity: TranscriptAttachment = {
        attachmentId: `att_${attachments.length + 1}`,
        mediaType: attachment.mediaType,
        name: attachment.name,
        size: attachment.size,
      };
      attachments.push(entity);
      ids.push(entity.attachmentId);
    }
    return { text: texts.join(''), attachmentIds: ids.length > 0 ? ids : undefined };
  };

  const ensureTurn = (origin: TurnOrigin = FALLBACK_ORIGIN): TurnDraft => {
    if (!turn) {
      const ordinal = nextOrdinal;
      nextOrdinal += 1;
      turn = { turnId: `t${ordinal}`, ordinal, origin, steps: [] };
      turnIndices.set(turn.turnId, items.length);
      items.push(draftToTurnItem(turn));
    }
    return turn;
  };

  const flushSteeredLeftovers = (): void => {
    const leftovers = pendingNotificationFrames.filter((pending) => pending.steered);
    if (leftovers.length === 0) return;
    pendingNotificationFrames = pendingNotificationFrames.filter((pending) => !pending.steered);
    for (const pending of leftovers) {
      const targetTurn = turn ?? startTurn({ kind: 'user' });
      let lastStep = targetTurn.steps.at(-1);
      if (lastStep === undefined) {
        const ordinal = targetTurn.steps.length + 1;
        lastStep = {
          stepId: `${targetTurn.turnId}.${ordinal}`,
          ordinal,
          frames: [],
        };
        targetTurn.steps.push(lastStep);
      }
      lastStep.frames.push({
        kind: 'text',
        frameId: `${lastStep.stepId}.f${lastStep.frames.length + 1}`,
        role: 'user',
        text: pending.text,
        attachmentIds: pending.attachmentIds,
        promptIds: pending.promptIds,
        origin: pending.origin,
      });
      syncTurnItem(items, turnIndices, targetTurn);
    }
  };

  const startTurn = (
    origin: TurnOrigin,
    prompt?: string,
    attachmentIds?: string[],
    triggerPromptId?: string,
  ): TurnDraft => {
    flushSteeredLeftovers();
    const ordinal = nextOrdinal;
    nextOrdinal += 1;
    pendingNotificationFrames = [];
    turn = {
      turnId: `t${ordinal}`,
      ordinal,
      triggerPromptId,
      origin,
      prompt,
      attachmentIds,
      steps: [],
    };
    turnIndices.set(turn.turnId, items.length);
    items.push(draftToTurnItem(turn));
    return turn;
  };

  const pushMarker = (marker: string, payload?: unknown): void => {
    markerCount += 1;
    const item: TranscriptMarker = { kind: 'marker', markerId: `m${markerCount}`, marker, payload };
    items.push(item);
  };

  const extractBundledSkillMarkers = (message: HistoryMessage): HistoryMessage => {
    const bundled = bundledSkillActivations(message);
    const annotated = annotateBundledSkillParts(message.content ?? [], bundled);
    const skillParts = annotated.filter(isSkillActivationPart);
    bundled.forEach((activation, index) => {
      const block = skillParts[index];
      pushMarker('skill', {
        text: block !== undefined && block.type === 'text' && 'text' in block ? block.text : '',
        origin: { kind: 'skill_activation', trigger: 'user-slash', ...activation },
      });
    });
    return { ...message, content: annotated.filter((part) => !isSkillActivationPart(part)) };
  };

  let prevNonTaskRole: string | undefined;
  const add = (entry: HistoryMessage): void => {
    const content =
      entry.content === undefined ? undefined : withoutUserPromptSubmitHookParts(entry.content);
    const hookParts =
      entry.content === undefined || content === entry.content
        ? []
        : entry.content.filter(isUserPromptSubmitHookPart);
    const message = content === entry.content ? entry : { ...entry, content };
    if (message.role === 'system') return;
    const originKind = message.origin?.kind;
    const isTaskOrigin =
      originKind === 'task' ||
      originKind === 'background_task' ||
      originKind === 'task_notification';
    const prevRoleAtEntry = prevNonTaskRole;
    if (!isTaskOrigin) prevNonTaskRole = message.role;

    if (message.role === 'user') {
      for (const part of hookParts) {
        pushMarker('hook', userPromptSubmitHookMarkerPayload(part));
      }
      if (originKind !== undefined && HIDDEN_USER_ORIGINS.has(originKind)) {
        if (opensOwnTurn(message)) {
          const opening =
            (message.origin as { name?: unknown }).name === 'subagent'
              ? foldTurnOpeningInput(message)
              : undefined;
          startTurn(mapOrigin(message), opening?.text || undefined, opening?.attachmentIds);
        }
        return;
      }
      const markerKey = originKind !== undefined ? MARKER_USER_ORIGINS[originKind] : undefined;
      if (markerKey !== undefined && !isUserSlashOrigin(message.origin)) {
        pushMarker(markerKey, { text: textOf(message), origin: message.origin });
        return;
      }
      const contentKey = JSON.stringify(message.content ?? []);
      const steerKind = originKind ?? 'user';
      const opensAsTurnPrompt =
        message.id !== undefined && options?.turnPromptIds?.has(message.id) === true;
      const steeredPromptIds =
        !opensAsTurnPrompt && message.id !== undefined
          ? steeredByMessageId.get(message.id)
          : undefined;
      const steeredById = steeredPromptIds !== undefined;
      if (steeredById && message.id !== undefined) {
        steeredByMessageId.delete(message.id);
        consumedSteerMessageIds.add(message.id);
      }
      const steeredByKind =
        opensAsTurnPrompt || steeredById ? undefined : steeredContents.get(contentKey);
      const steeredRemaining = steeredByKind?.get(steerKind) ?? 0;
      if (steeredById || (steeredByKind !== undefined && steeredRemaining > 0)) {
        if (!steeredById) {
          steeredByKind!.set(steerKind, steeredRemaining - 1);
          const consumed = consumedSteeredContents.get(contentKey) ?? new Map<string, number>();
          consumed.set(steerKind, (consumed.get(steerKind) ?? 0) + 1);
          consumedSteeredContents.set(contentKey, consumed);
        }
        const opening = foldTurnOpeningInput(extractBundledSkillMarkers(message));
        pendingNotificationFrames.push({
          text: opening.text,
          taskId: undefined,
          attachmentIds: opening.attachmentIds,
          origin: projectTranscriptUserOrigin(message.origin),
          promptIds:
            steeredPromptIds !== undefined && steeredPromptIds.length > 0
              ? steeredPromptIds
              : undefined,
          steered: true,
        });
        return;
      }
      if (markerKey !== undefined) {
        const opening = isUserSlashOrigin(message.origin)
          ? foldTurnOpeningInput(message)
          : undefined;
        pushMarker(markerKey, { text: opening?.text ?? textOf(message), origin: message.origin });
        if (opening !== undefined) {
          startTurn(
            mapOrigin(message),
            opening.text,
            opening.attachmentIds,
            triggerPromptIdOf(message),
          );
        }
        return;
      }
      if (isTaskOrigin) {
        const origin = message.origin as { taskId?: unknown } | undefined;
        const taskId = typeof origin?.taskId === 'string' ? origin.taskId : undefined;
        const opensOwn =
          options?.taskOriginTurnTaskIds === undefined
            ? prevRoleAtEntry !== 'assistant' && prevRoleAtEntry !== 'tool'
            : taskId === undefined ||
              options.taskOriginTurnTaskIds.has(taskId) ||
              originKind === 'background_task';
        if (opensOwn) {
          const opening = foldTurnOpeningInput(message);
          startTurn(mapOrigin(message), opening.text, opening.attachmentIds);
          return;
        }
        pendingNotificationFrames.push({ text: notificationFrameText(textOf(message)), taskId });
        return;
      }
      const bundled = bundledSkillActivations(message);
      if (bundled.length > 0) {
        const callerMessage = extractBundledSkillMarkers(message);
        const opening = foldTurnOpeningInput(callerMessage);
        startTurn(
          mapOrigin(message),
          opening.text,
          opening.attachmentIds,
          triggerPromptIdOf(message),
        );
        return;
      }
      const opening = foldTurnOpeningInput(message);
      startTurn(
        mapOrigin(message),
        opening.text,
        opening.attachmentIds,
        triggerPromptIdOf(message),
      );
      return;
    }

    if (message.role === 'assistant') {
      const current = ensureTurn();
      const stepOrdinal = current.steps.length + 1;
      const step: StepDraft = {
        stepId: `${current.turnId}.${stepOrdinal}`,
        ordinal: stepOrdinal,
        frames: [],
        usage: message.usage,
        llmTiming: message.llmTiming,
      };
      current.steps.push(step);
      let frameCount = 0;
      const nextFrameId = (): string => {
        frameCount += 1;
        return `${step.stepId}.f${frameCount}`;
      };
      for (const pending of pendingNotificationFrames) {
        step.frames.push({
          kind: 'text',
          frameId: nextFrameId(),
          role: 'user',
          text: pending.text,
          taskId: pending.taskId,
          attachmentIds: pending.attachmentIds,
          promptIds: pending.promptIds,
          origin: pending.origin,
        });
      }
      pendingNotificationFrames = [];
      for (const part of message.content ?? []) {
        if (
          part.type === 'text' &&
          'text' in part &&
          typeof part.text === 'string' &&
          part.text.length > 0
        ) {
          step.frames.push({
            kind: 'text',
            frameId: nextFrameId(),
            role: 'assistant',
            text: part.text,
          });
        } else if (
          part.type === 'think' &&
          'think' in part &&
          typeof part.think === 'string' &&
          part.think.length > 0 &&
          part.hidden !== true
        ) {
          step.frames.push({ kind: 'thinking', frameId: nextFrameId(), text: part.think });
        }
      }
      for (const call of message.toolCalls ?? []) {
        step.frames.push({
          kind: 'tool',
          frameId: `${step.stepId}.${call.id}`,
          toolCallId: call.id,
          name: call.name,
          state: 'running',
          input: parseArguments(call.arguments),
        });
      }
      syncTurnItem(items, turnIndices, current);
      return;
    }

    if (message.role === 'tool') {
      const frame = currentTurnToolFrame(turn, message.toolCallId);
      if (frame && frame.kind === 'tool') {
        const output = toolOutputOf(message);
        const patched: TranscriptFrame = {
          ...frame,
          state: message.isError ? 'error' : 'done',
          output,
          error: message.isError ? textOf(message) : undefined,
        };
        replaceToolFrame(turn!, message.toolCallId!, patched);
        syncTurnItem(items, turnIndices, turn!);
      }
    }
  };

  const snapshot = (): AgentTranscriptSnapshot => ({
    items: [...items],
    tasks: [],
    interactions: [],
    attachments: [...attachments],
    prompts: [],
  });

  const result = (): AgentTranscriptSnapshot => {
    if (!pendingNotificationFrames.some((pending) => pending.steered)) return snapshot();
    const savedItems = [...items];
    const savedTurnIndices = new Map(turnIndices);
    const savedTurn = turn;
    const savedPending = pendingNotificationFrames;
    const savedNextOrdinal = nextOrdinal;
    if (turn !== undefined) {
      turn = {
        ...turn,
        steps: turn.steps.map((step) => ({ ...step, frames: [...step.frames] })),
      };
    }
    flushSteeredLeftovers();
    const output = snapshot();
    items.length = 0;
    items.push(...savedItems);
    turnIndices.clear();
    for (const [id, index] of savedTurnIndices) turnIndices.set(id, index);
    turn = savedTurn;
    pendingNotificationFrames = savedPending;
    nextOrdinal = savedNextOrdinal;
    return output;
  };

  return { syncOptions, add, result };
}

function notificationFrameText(text: string): string {
  if (!text.startsWith('<notification')) return text;
  const openingEnd = text.indexOf('>');
  const closingStart = text.lastIndexOf('</notification>');
  if (openingEnd === -1 || closingStart <= openingEnd) return text;
  const inner = text.slice(openingEnd + 1, closingStart);
  const lines = inner.split('\n');
  let headerEnd = 0;
  while (headerEnd < lines.length && lines[headerEnd]!.trim() === '') headerEnd += 1;
  let title = '';
  let bodyStart = headerEnd;
  const titleLine = lines[bodyStart];
  if (titleLine !== undefined && titleLine.startsWith('Title: ')) {
    title = titleLine.slice('Title: '.length);
    bodyStart += 1;
  }
  const severityLine = lines[bodyStart];
  if (severityLine !== undefined && severityLine.startsWith('Severity: ')) {
    bodyStart += 1;
  }
  const bodyLines = lines.slice(bodyStart);
  const childStart = bodyLines.findIndex((line) => {
    const trimmed = line.trimStart();
    return (
      trimmed.startsWith('<output-file') ||
      trimmed.startsWith('<output-preview') ||
      trimmed.startsWith('<answer')
    );
  });
  const body = (childStart === -1 ? bodyLines : bodyLines.slice(0, childStart)).join('\n').trim();
  if (title.length > 0 && body.length > 0) return `${title}\n${body}`;
  return title.length > 0 ? title : body.length > 0 ? body : text;
}

function opensOwnTurn(message: HistoryMessage): boolean {
  const origin = message.origin as { kind?: unknown; name?: unknown } | undefined;
  return (
    origin?.kind === 'system_trigger' &&
    typeof origin.name === 'string' &&
    TURN_OPENING_SYSTEM_TRIGGERS.has(origin.name)
  );
}

function triggerPromptIdOf(message: HistoryMessage): string | undefined {
  if (typeof message.id !== 'string' || message.id.length === 0) return undefined;
  const origin = message.origin as { kind?: unknown; trigger?: unknown } | undefined;
  if (origin?.kind === undefined || origin.kind === 'user') return message.id;
  return (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
    ? message.id
    : undefined;
}

function mapOrigin(message: HistoryMessage): TurnOrigin {
  const origin = message.origin;
  if (origin?.kind === undefined) return { kind: 'user' };
  return mapTurnOrigin(origin);
}

interface BundledSkillActivation {
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly skillType?: string;
  readonly skillPath?: string;
  readonly skillSource?: string;
}

function bundledSkillActivations(message: HistoryMessage): readonly BundledSkillActivation[] {
  if (message.origin?.kind !== 'user') return [];
  const activations = (message.origin as { readonly skillActivations?: unknown }).skillActivations;
  if (!Array.isArray(activations)) return [];
  return activations.filter(
    (activation): activation is BundledSkillActivation =>
      typeof activation === 'object' &&
      activation !== null &&
      typeof (activation as { activationId?: unknown }).activationId === 'string' &&
      typeof (activation as { skillName?: unknown }).skillName === 'string',
  );
}

interface OriginFileAttachment {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly path: string;
}

function originFileAttachments(message: HistoryMessage): readonly OriginFileAttachment[] {
  if (message.origin?.kind !== 'user' && message.origin?.kind !== 'skill_activation') return [];
  const attachments = (message.origin as { readonly attachments?: unknown }).attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.filter(
    (attachment): attachment is OriginFileAttachment =>
      typeof attachment === 'object' &&
      attachment !== null &&
      typeof (attachment as { name?: unknown }).name === 'string' &&
      typeof (attachment as { mediaType?: unknown }).mediaType === 'string' &&
      typeof (attachment as { size?: unknown }).size === 'number' &&
      typeof (attachment as { path?: unknown }).path === 'string',
  );
}

function textOf(message: HistoryMessage): string {
  return (message.content ?? [])
    .filter(
      (part): part is { readonly type: 'text'; readonly text: string } =>
        part.type === 'text' && 'text' in part,
    )
    .map((part) => part.text)
    .join('');
}

function parseArguments(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function draftToTurnItem(draft: TurnDraft): TranscriptItem {
  return {
    kind: 'turn',
    turnId: draft.turnId,
    triggerPromptId: draft.triggerPromptId,
    ordinal: draft.ordinal,
    state: 'completed',
    origin: draft.origin,
    prompt: draft.prompt,
    attachmentIds: draft.attachmentIds,
    steps: draft.steps.map((step) => ({
      kind: 'step' as const,
      stepId: step.stepId,
      turnId: draft.turnId,
      ordinal: step.ordinal,
      state: 'completed' as const,
      frames: step.frames,
      usage: step.usage,
      llmTiming: step.llmTiming,
    })),
  };
}

function syncTurnItem(
  items: TranscriptItem[],
  indices: ReadonlyMap<string, number>,
  draft: TurnDraft,
): void {
  const index = indices.get(draft.turnId);
  if (index !== undefined) items[index] = draftToTurnItem(draft);
}

function currentTurnToolFrame(
  turn: TurnDraft | undefined,
  toolCallId: string | undefined,
): TranscriptFrame | undefined {
  if (!turn || toolCallId === undefined) return undefined;
  for (let s = turn.steps.length - 1; s >= 0; s -= 1) {
    const frames = turn.steps[s]?.frames ?? [];
    for (let f = frames.length - 1; f >= 0; f -= 1) {
      const frame = frames[f];
      if (frame?.kind === 'tool' && frame.toolCallId === toolCallId) return frame;
    }
  }
  return undefined;
}

function replaceToolFrame(turn: TurnDraft, toolCallId: string, next: TranscriptFrame): void {
  for (let s = turn.steps.length - 1; s >= 0; s -= 1) {
    const step = turn.steps[s];
    if (!step) continue;
    const index = step.frames.findIndex(
      (frame) => frame.kind === 'tool' && frame.toolCallId === toolCallId,
    );
    if (index >= 0) {
      step.frames[index] = next;
      return;
    }
  }
}
