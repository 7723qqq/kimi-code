import { describe, expect, it } from 'bun:test';

import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';
import { googleGenAIProtocol } from '#/llm/builtin/protocol/google-genai/index';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { openAIResponsesProtocol } from '#/llm/builtin/protocol/openai-responses/index';
import type { LlmModule } from '#/llm/protocol/protocol';
import type { Message } from '#/llm/message';

import { testModule } from './harness';

const PDF_DATA_URL = 'data:application/pdf;base64,QUJD';

const documentMessage: Message = {
  role: 'user',
  content: [
    {
      type: 'document_url',
      documentUrl: { url: PDF_DATA_URL, mimeType: 'application/pdf', name: 'spec.pdf' },
    },
  ],
};

function moduleWithDocument<TOptions>(): LlmModule<TOptions> {
  return testModule<TOptions>({ messages: [documentMessage] });
}

describe('document part lowering', () => {
  it('sends an Anthropic document block with the declared mime type', () => {
    const request = anthropicProtocol.encode(moduleWithDocument());
    const message = request.params.messages[0];
    expect(message?.content[0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' },
    });
  });

  it('sends a Google GenAI inlineData part with the document mime type', () => {
    const request = googleGenAIProtocol.encode(moduleWithDocument());
    const contents = request.params.contents;
    const first = Array.isArray(contents) ? contents[0] : undefined;
    expect(first).toEqual({
      role: 'user',
      parts: [{ inlineData: { mimeType: 'application/pdf', data: 'QUJD' } }],
    });
  });

  it('sends an OpenAI file part carrying the data URL', () => {
    const request = openAIProtocol.encode(moduleWithDocument());
    const content = request.params.messages[0]?.content;
    expect(Array.isArray(content) ? content[0] : undefined).toEqual({
      type: 'file',
      file: { file_data: PDF_DATA_URL, filename: 'spec.pdf' },
    });
  });

  it('sends an OpenAI Responses input_file item carrying the data URL', () => {
    const request = openAIResponsesProtocol.encode(moduleWithDocument());
    expect(request.params.input?.[0]).toMatchObject({
      type: 'message',
      content: [{ type: 'input_file', file_data: PDF_DATA_URL, filename: 'spec.pdf' }],
    });
  });
});
