import { type Message } from '#/llm/message';
import type { ToolMessageConversion } from '#/llm/requester/requester';
import type { OpenAIWireMessage } from './contract';
export interface OpenAILowerContext {
    readonly reasoningKey: string;
    readonly preserveThinking: boolean;
    readonly echoFullReasoning: boolean;
    readonly toolMessageConversion: ToolMessageConversion | undefined;
}
export declare function lowerMessage(message: Message, lower: OpenAILowerContext): OpenAIWireMessage[];
