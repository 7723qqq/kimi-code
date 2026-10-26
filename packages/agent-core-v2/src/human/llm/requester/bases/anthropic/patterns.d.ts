import type { Message } from '#/llm/message';
import type { Pattern } from '#/llm/protocol/rewrite';
export declare function stripUnsignedThinking(options: {
    readonly preserve: boolean;
}): Pattern<Message>;
export declare const audioToPlaceholder: Pattern<Message>;
