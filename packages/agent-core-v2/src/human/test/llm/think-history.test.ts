import { describe, expect, it } from 'vitest';

import { encodeOpenAIThinkHistoryKwargs } from '#/llm/requester/bases/openai/format';

describe('encodeOpenAIThinkHistoryKwargs', () => {
  it('uses the deepseek family history default', () => {
    expect(encodeOpenAIThinkHistoryKwargs('deepseek-v4-pro')).toEqual({
      reasoning_effort: 'high',
    });
    expect(encodeOpenAIThinkHistoryKwargs('deepseek-v3')).toEqual({ reasoning_effort: 'high' });
    expect(encodeOpenAIThinkHistoryKwargs('workbuddy/deepseek-v4.1-flash')).toEqual({
      reasoning_effort: 'high',
    });
  });

  it('keeps the generic default outside a registered family', () => {
    expect(encodeOpenAIThinkHistoryKwargs('gpt-4o')).toEqual({ reasoning_effort: 'high' });
    expect(encodeOpenAIThinkHistoryKwargs('my-deepseek-clone')).toEqual({
      reasoning_effort: 'high',
    });
    expect(encodeOpenAIThinkHistoryKwargs('')).toEqual({ reasoning_effort: 'high' });
  });
});
