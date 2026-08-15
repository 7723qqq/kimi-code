// apps/kimi-web/src/lib/messageFeedback.ts
// Local message feedback (like/dislike + optional note). The daemon has no
// feedback endpoint yet, so this is a browser-local preference keyed by turn
// id — a stopgap until server-side feedback lands (deferred, see
// docs/kimi-web-vs-deepseekharness-gap.md).

export interface MessageFeedback {
  vote: 'like' | 'dislike' | null;
  note?: string;
}

const PREFIX = 'kimi-web.feedback.';

function keyOf(turnId: string): string {
  return `${PREFIX}${turnId}`;
}

export function getMessageFeedback(turnId: string): MessageFeedback | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(keyOf(turnId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MessageFeedback;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed.vote === 'like' || parsed.vote === 'dislike' || parsed.vote === null)
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function setMessageFeedback(turnId: string, feedback: MessageFeedback): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(keyOf(turnId), JSON.stringify(feedback));
}

export function clearMessageFeedback(turnId: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(keyOf(turnId));
}
