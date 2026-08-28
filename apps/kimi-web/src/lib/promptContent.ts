import type { AppMessage, AppMessageContent, PromptAttachment } from '../api/types';

/** Build the wire content blocks for a prompt: the text as a text part, then
    one block per attachment (images/videos as media parts, anything else as a
    file part the server materializes). Shared by the normal send path and the
    steer path so both produce identical blocks. */
export function buildPromptContent(
  text: string,
  attachments?: readonly PromptAttachment[],
): AppMessageContent[] {
  const content: AppMessageContent[] = [];
  if (text) content.push({ type: 'text', text });
  for (const att of attachments ?? []) {
    if (att.kind === 'video')
      content.push({ type: 'video', source: { kind: 'file', fileId: att.fileId } });
    else if (att.kind === 'file') {
      content.push({
        type: 'file',
        fileId: att.fileId,
        name: att.name ?? '',
        mediaType: att.mediaType || 'application/octet-stream',
        size: att.size ?? 0,
      });
    } else content.push({ type: 'image', source: { kind: 'file', fileId: att.fileId } });
  }
  return content;
}

/** Build the optimistic user message echoed into the transcript before the
    daemon answers (the daemon emits no user-message WS event of its own). */
export function createOptimisticUserMessage(
  id: string,
  sessionId: string,
  content: AppMessageContent[],
): AppMessage {
  return {
    id,
    sessionId,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
    metadata: { 'kimiWeb.optimisticUserMessage': true },
  };
}

/** Transcript updater: stamp the authoritative daemon prompt_id onto the
    optimistic message without changing its id (ChatPane keys user turns by
    message id, so replacing the id would remount the bubble and flicker). */
export function stampPromptId(
  tempId: string,
  promptId: string,
): (msgs: AppMessage[]) => AppMessage[] {
  return (msgs) => {
    const idx = msgs.findIndex((m) => m.id === tempId);
    if (idx === -1) return msgs;
    const updated = [...msgs];
    updated[idx] = { ...updated[idx]!, promptId: updated[idx]!.promptId ?? promptId };
    return updated;
  };
}

/** Transcript updater that drops the optimistic echo (submit failed). */
export function withoutOptimisticMessage(
  tempId: string,
): (msgs: AppMessage[]) => AppMessage[] {
  return (msgs) => msgs.filter((m) => m.id !== tempId);
}