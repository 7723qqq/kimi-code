import { randomUUID } from 'node:crypto';

import type { LlmModel } from '#human/llm/model';

export const SESSION_HEADER = 'x-opencode-session';

let processSessionId: string | undefined;

function fallbackSessionId(): string {
  processSessionId ??= `ses_${randomUUID().replaceAll('-', '')}`;
  return processSessionId;
}

function hasHeader(headers: Readonly<Record<string, string>> | undefined, name: string): boolean {
  if (headers === undefined) return false;
  const target = name.toLowerCase();
  return Object.entries(headers).some(
    ([key, value]) => key.toLowerCase() === target && value.trim().length > 0,
  );
}

export function withSessionHeader(model: LlmModel, sessionId: string | undefined): LlmModel {
  if (hasHeader(model.defaultHeaders, SESSION_HEADER)) return model;
  const declared = sessionId?.trim();
  return {
    ...model,
    defaultHeaders: {
      ...model.defaultHeaders,
      [SESSION_HEADER]:
        declared === undefined || declared.length === 0 ? fallbackSessionId() : declared,
    },
  };
}
