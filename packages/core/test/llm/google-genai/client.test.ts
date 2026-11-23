import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const actualGoogleGenAI = await import('@google/genai');
const genAIConstructor = mock();

mock.module('@google/genai', () => ({
  ...actualGoogleGenAI,
  GoogleGenAI: genAIConstructor,
}));

afterAll(() => {
  mock.restore();
});

const { googleGenAIProtocol } = await import('#/llm/builtin/protocol/google-genai/index');

describe('Google GenAI client', () => {
  beforeEach(() => {
    genAIConstructor.mockClear();
  });

  it('passes Vertex project and location to the SDK when using ADC', () => {
    googleGenAIProtocol.client(
      {},
      { vertexai: true, project: 'test-project', location: 'test-location' },
    );

    expect(genAIConstructor).toHaveBeenCalledTimes(1);
    expect(genAIConstructor).toHaveBeenCalledWith({
      apiKey: undefined,
      vertexai: true,
      project: 'test-project',
      location: 'test-location',
      httpOptions: undefined,
    });
  });

  it('keeps Vertex API key requests projectless', () => {
    googleGenAIProtocol.client(
      { apiKey: 'test-key' },
      { vertexai: true, project: 'test-project', location: 'test-location' },
    );

    expect(genAIConstructor).toHaveBeenCalledTimes(1);
    expect(genAIConstructor).toHaveBeenCalledWith({
      apiKey: 'test-key',
      vertexai: true,
      project: undefined,
      location: undefined,
      httpOptions: undefined,
    });
  });
});
