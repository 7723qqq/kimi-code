import type { Message } from '#/llm/message';
import type { AnthropicWireContentBlock, AnthropicWireMessage } from './contract';
export declare function messageContent(message: AnthropicWireMessage): AnthropicWireContentBlock[];
export declare function isAnthropicWireMessageEmpty(message: AnthropicWireMessage): boolean;
export declare function lowerMessage(message: Message, acceptedMimes: ReadonlySet<string>): AnthropicWireMessage[];
