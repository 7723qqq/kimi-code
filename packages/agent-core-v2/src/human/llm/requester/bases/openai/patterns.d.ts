import type { Message } from '#/llm/message';
import type { Pattern } from '#/llm/protocol/rewrite';
export declare const TOOL_RESULT_MEDIA_PROMPT = "Attached media from tool result:";
export declare const TOOL_RESULT_MEDIA_PLACEHOLDER = "(see attached media)";
export declare const extractToolMedia: Pattern<Message>;
