import type { ContentPart } from '#/app/llmProtocol/message';
import type { IEventService } from '#/app/event/event';
import type { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import type {
  ActivatePluginCommandPayload,
  ActivateSkillPayload,
  PromptPayload,
} from './core-api';

const MAX_TITLE_LENGTH = 200;
const MAX_LAST_PROMPT_LENGTH = 4000;

export function titleFromPromptMetadataText(text: string): string {
  return text.slice(0, MAX_TITLE_LENGTH);
}

export function promptMetadataTextFromPayload(payload: PromptPayload): string | undefined {
  return promptMetadataTextFromContentParts(payload.input);
}

/**
 * Extract the title/lastPrompt source text from already-projected core
 * `ContentPart`s (the `{ text | image_url | video_url | ... }` shape). Shared by
 * the `/api/v2` RPC entry (`PromptPayload.input`) and the `/api/v1` legacy
 * entry (`PromptSubmission.content` projected via `contentToCoreParts`), so the
 * easy-title derivation is identical on both surfaces — mirroring v1, where
 * the web REST submit funnels through the same `core.rpc.prompt` that derives
 * the title.
 */
export function promptMetadataTextFromContentParts(
  parts: readonly ContentPart[],
): string | undefined {
  const texts: string[] = [];
  for (const part of parts) {
    const text = promptPartText(part);
    if (text !== undefined) texts.push(text);
  }
  return sanitizeAndTruncatePromptText(texts.join('\n'), MAX_LAST_PROMPT_LENGTH);
}

export function promptMetadataTextFromSkill(payload: ActivateSkillPayload): string | undefined {
  const args = payload.args?.trim();
  return sanitizeAndTruncatePromptText(
    args === undefined || args.length === 0 ? `/${payload.name}` : `/${payload.name} ${args}`,
    MAX_LAST_PROMPT_LENGTH,
  );
}

export function promptMetadataTextFromPluginCommand(
  payload: ActivatePluginCommandPayload,
): string | undefined {
  const args = payload.args?.trim();
  const command = `/${payload.pluginId}:${payload.commandName}`;
  return sanitizeAndTruncatePromptText(
    args === undefined || args.length === 0 ? command : `${command} ${args}`,
    MAX_LAST_PROMPT_LENGTH,
  );
}

/** Mirrors v1's `isUntitled`: empty / missing / the default "New Session". */
export function isUntitled(title: string | undefined): boolean {
  return title === undefined || title.trim().length === 0 || title === 'New Session';
}

export interface PromptMetadataUpdateTarget {
  readonly metadata: ISessionMetadata;
  readonly eventService: IEventService;
  readonly sessionId: string;
}

/**
 * Mirror v1's `Session.updatePromptMetadata`: persist the prompt text as
 * `lastPrompt` and, when the session is still untitled and has no custom title,
 * derive an easy `title` from it. Then broadcast `session.meta.updated` on the
 * global `IEventService` so the web session list / title updates live (the edge
 * fans it out to every connection, not just this session's subscribers).
 *
 * Single source of truth shared by the `/api/v2` RPC entry (`AgentRPCService`)
 * and the `/api/v1` legacy entry (`AgentPromptLegacyService`); v1 keeps this
 * logic in the one `core.rpc.prompt` that both the TUI and the web funnel
 * through.
 */
export async function applyPromptMetadataUpdate(
  target: PromptMetadataUpdateTarget,
  text: string | undefined,
): Promise<void> {
  if (text === undefined) return;
  const current = await target.metadata.read();
  const patch: { lastPrompt: string; title?: string; isCustomTitle?: boolean } = {
    lastPrompt: text,
  };
  if (!current.isCustomTitle && isUntitled(current.title)) {
    patch.title = titleFromPromptMetadataText(text);
    patch.isCustomTitle = false;
  }
  await target.metadata.update(patch);
  target.eventService.publish({
    type: 'session.meta.updated',
    payload: {
      agentId: 'main',
      sessionId: target.sessionId,
      title: patch.title,
      patch: {
        title: patch.title,
        isCustomTitle: patch.isCustomTitle,
        lastPrompt: text,
      },
    },
  });
}

function promptPartText(part: ContentPart): string | undefined {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'image_url':
      return '[image]';
    case 'audio_url':
      return '[audio]';
    case 'video_url':
      return '[video]';
    case 'think':
      return undefined;
  }
}

function sanitizeAndTruncatePromptText(text: string, maxLength: number): string | undefined {
  const sanitized = text
    .replaceAll(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
      '[redacted]',
    )
    .replaceAll(/\b(authorization)\s*:\s*bearer\s+\S+/gi, '$1: Bearer [redacted]')
    .replaceAll(
      /\b(api[_-]?key|token|secret|password|passwd|pwd)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1=[redacted]',
    )
    .replaceAll(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replaceAll(/\b[A-Za-z0-9][A-Za-z0-9+/=_-]{39,}\b/g, '[redacted]')
    .replaceAll(/\p{Cc}+/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();

  if (sanitized.length === 0) return undefined;
  return sanitized.slice(0, maxLength);
}
