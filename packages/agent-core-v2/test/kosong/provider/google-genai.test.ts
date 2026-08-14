/**
 * `kosong/provider` GoogleGenAI wire probes — `GoogleGenAIStreamedMessage`
 * usage extraction.
 *
 * Gemini streaming reports `usageMetadata` across chunks: the first chunk
 * carries the prompt side (`promptTokenCount` / `cachedContentTokenCount`),
 * the final chunk the output side (`candidatesTokenCount`). Usage must be
 * accumulated per component so a later chunk with a missing field never
 * zeroes a value an earlier chunk already reported.
 */

import { describe, expect, it } from 'vitest';

import { GoogleGenAIStreamedMessage } from '#/kosong/provider/bases/google-genai/google-genai';

async function* chunkStream(chunks: readonly Record<string, unknown>[]) {
  yield* chunks;
}

async function consume(message: GoogleGenAIStreamedMessage): Promise<void> {
  for await (const _part of message) {
    void _part;
  }
}

describe('GoogleGenAIStreamedMessage streaming usage', () => {
  it('keeps the prompt-side usage when the final chunk only reports output', async () => {
    const message = new GoogleGenAIStreamedMessage(
      chunkStream([
        {
          usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 30 },
        },
        {
          candidates: [{ content: { parts: [{ text: 'pong' }] } }],
        },
        {
          usageMetadata: { candidatesTokenCount: 5 },
        },
      ]),
      true,
    );

    await consume(message);

    expect(message.usage).toEqual({
      inputOther: 70,
      output: 5,
      inputCacheRead: 30,
      inputCacheCreation: 0,
    });
  });

  it('only overrides the components a chunk actually reports', async () => {
    const message = new GoogleGenAIStreamedMessage(
      chunkStream([
        {
          usageMetadata: {
            promptTokenCount: 200,
            cachedContentTokenCount: 40,
            candidatesTokenCount: 0,
          },
        },
        { usageMetadata: { candidatesTokenCount: 12 } },
      ]),
      true,
    );

    await consume(message);

    expect(message.usage).toEqual({
      inputOther: 160,
      output: 12,
      inputCacheRead: 40,
      inputCacheCreation: 0,
    });
  });

  it('stays null while no chunk carries usage metadata', async () => {
    const message = new GoogleGenAIStreamedMessage(
      chunkStream([{ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }]),
      true,
    );

    await consume(message);

    expect(message.usage).toBeNull();
  });
});

describe('GoogleGenAIStreamedMessage non-stream usage', () => {
  it('maps the full usage metadata in one pass', async () => {
    const message = new GoogleGenAIStreamedMessage(
      {
        candidates: [{ content: { parts: [{ text: 'pong' }] } }],
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 30,
          candidatesTokenCount: 5,
        },
      },
      false,
    );

    await consume(message);

    expect(message.usage).toEqual({
      inputOther: 70,
      output: 5,
      inputCacheRead: 30,
      inputCacheCreation: 0,
    });
  });
});
