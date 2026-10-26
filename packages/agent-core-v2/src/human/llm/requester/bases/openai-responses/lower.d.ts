import type { Message } from '#/llm/message';
import type { ResponsesInputItem } from './contract';
export interface OpenAIResponsesLowerContext {
    readonly modelName: string;
    readonly extractText: boolean;
}
export declare function lowerMessage(message: Message, lower: OpenAIResponsesLowerContext): ResponsesInputItem[];
