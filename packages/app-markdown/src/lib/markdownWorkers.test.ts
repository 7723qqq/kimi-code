import { beforeAll, describe, expect, it, vi } from '@moonshot-ai/testkit/vitest';

void vi.mock('markstream-vue', () => ({
  setKaTeXWorker: vi.fn(),
  clearKaTeXWorker: vi.fn(),
  setMermaidWorker: vi.fn(),
  clearMermaidWorker: vi.fn(),
}));
void vi.mock('markstream-vue/workers/katexRenderer.worker?worker&type=module', () => ({
  default: class FakeKatexWorker {},
}));
void vi.mock('markstream-vue/workers/mermaidParser.worker?worker&type=module', () => ({
  default: class FakeMermaidWorker {},
}));

vi.hoisted(() => {
  vi.stubGlobal('Worker', class {});
});

// vitest hoists `vi.mock` above the static imports; bun's `mock.module` does
// not, so the modules under test are loaded after the mocks are registered.
let markstream: typeof import('markstream-vue');
let workers: typeof import('./markdownWorkers');

describe('ensureMarkdownWorkers', () => {
  beforeAll(async () => {
    markstream = await import('markstream-vue');
    workers = await import('./markdownWorkers');
  });

  it('registers the pair on module evaluation (before any explicit call)', () => {
    expect(vi.mocked(markstream.setKaTeXWorker)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markstream.setMermaidWorker)).toHaveBeenCalledTimes(1);
  });

  it('creates the shared worker pair exactly once across repeated calls', () => {
    workers.ensureMarkdownWorkers();
    workers.ensureMarkdownWorkers();
    workers.ensureMarkdownWorkers();

    expect(vi.mocked(markstream.setKaTeXWorker)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markstream.setMermaidWorker)).toHaveBeenCalledTimes(1);
  });

  it('passes a worker instance to each registrar', () => {
    workers.ensureMarkdownWorkers();

    expect(vi.mocked(markstream.setKaTeXWorker).mock.calls[0]?.[0]).toBeDefined();
    expect(vi.mocked(markstream.setMermaidWorker).mock.calls[0]?.[0]).toBeDefined();
  });

  it('never tears the pair down on (re)mount', () => {
    workers.ensureMarkdownWorkers();

    expect(vi.mocked(markstream.clearKaTeXWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(markstream.clearMermaidWorker)).not.toHaveBeenCalled();
  });
});
