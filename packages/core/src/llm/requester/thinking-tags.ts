import type { ResponseFormat } from '../response-format';
import { createThinkingTagParser } from '../thinking-tags';
import type { LlmRequestControl } from './requester';

export function createThinkingTagEventHandler(
  control: Pick<LlmRequestControl, 'onEvent' | 'onBufferedPart'>,
  responseFormat?: ResponseFormat,
): LlmRequestControl['onEvent'] {
  const { onEvent, onBufferedPart } = control;
  if (onEvent === undefined || responseFormat !== undefined) return onEvent;
  const parser = createThinkingTagParser();
  return (event) => {
    switch (event.type) {
      case 'llm.sent':
      case 'llm.request.retrying':
        parser.finish();
        break;
      case 'llm.streaming.part': {
        const parts = parser.push(event.part);
        if (parts.length === 0) onBufferedPart?.();
        for (const part of parts) onEvent({ type: 'llm.streaming.part', part });
        return;
      }
      case 'llm.done':
      case 'llm.failed.remote':
      case 'llm.failed.syntax':
        for (const part of parser.finish()) onEvent({ type: 'llm.streaming.part', part });
        break;
    }
    onEvent(event);
  };
}
