import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { expect, it, vi } from '@moonshot-ai/testkit/vitest';

void vi.mock('markstream-vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('markstream-vue')>();
  return { ...actual, setCustomComponents: vi.fn(actual.setCustomComponents) };
});
void vi.mock('./lib/markdownWorkers', () => ({ ensureMarkdownWorkers: vi.fn() }));

// vitest hoists `vi.mock` above static imports; bun's `mock.module` does not,
// so the modules under test (and the mocked export) load after the mocks.
const { createKimiI18n } = await import('@moonshot-ai/app-i18n');
const { ResolveImageKey } = await import('@moonshot-ai/app-core/contracts');
const { setCustomComponents } = await import('markstream-vue');
const { default: Markdown } = await import('./Markdown.vue');

it('registers the kimi-markdown custom components once, not once per mounted instance', async () => {
  const app = createSSRApp({
    render: () => ['first block', 'second block', 'third block'].map(text => h(Markdown, { text })),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(ResolveImageKey, async (src: string) => src);
  const html = await renderToString(app);
  expect(html).toContain('third block');
  expect(vi.mocked(setCustomComponents)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(setCustomComponents)).toHaveBeenCalledWith('kimi-markdown', expect.objectContaining({ image: expect.anything() }));
});

it('renders raw HTML image tags as native elements', async () => {
  for (const text of [
    '<image src="https://example.com/image.png" title="Caption"></image>',
    '<svg><image href="https://example.com/image.png" /></svg>',
  ]) {
    const app = createSSRApp({ render: () => h(Markdown, { text }) });
    app.use(createKimiI18n({ locale: 'en' }));
    app.provide(ResolveImageKey, async (src: string) => src);
    const html = await renderToString(app);
    expect(html).toContain('<image');
    expect(html).toContain('https://example.com/image.png');
  }
});
