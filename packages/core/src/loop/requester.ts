import type { Message } from '@moonshot-ai/core/llm/message';
import type { LlmPolicy } from '@moonshot-ai/core/llm/policy/policy';
import { contentsOf, mergeFields, requesterContents, type LlmRequestPart } from '@moonshot-ai/core/llm/requester';
import type { LoopProfile } from './contract/profile';
import { requestProfileOf, type FullLoopLlmRequester } from './request';

type Fields = Readonly<Record<string, unknown>>;

export function createLoopRequester(
  requester: () => FullLoopLlmRequester,
  messages: () => readonly Message[],
  profile: () => LoopProfile,
  policy: () => LlmPolicy,
): FullLoopLlmRequester {
  const accumulate = (part: LlmRequestPart): FullLoopLlmRequester => {
    const resolve = (): FullLoopLlmRequester => requester().with({
      content: { messages: messages() },
      profile: requestProfileOf(profile()),
      policy: policy(),
    }).with(part);
    return {
      [requesterContents]: part,
      with: ((next: LlmRequestPart | FullLoopLlmRequester) =>
        accumulate(mergeFields(part as Fields, contentsOf(next) as Fields) as LlmRequestPart)) as FullLoopLlmRequester['with'],
      request: (rest) => resolve().request(rest),
      generate: (rest, control) => resolve().generate(rest, control),
    };
  };
  return accumulate({});
}
