import type { LlmErrorMessage } from '#/llm/errors';
export declare class SyntaxRequestFormatError extends Error {
    toLlmErrorMessage(): LlmErrorMessage<'syntax'>;
}
export declare function toLlmSyntaxErrorMessage(error: unknown): LlmErrorMessage<'syntax'>;
