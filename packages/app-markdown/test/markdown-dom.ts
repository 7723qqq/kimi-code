import '../../vite-preset/test/dom.mjs';

import { mock } from 'bun:test';
import { until } from '@moonshot-ai/testkit/fixtures';

import { stubGlobals } from '../../vite-preset/test/globals';

const markstream = { ...await import('markstream-vue') };
void mock.module('markstream-vue', () => ({
  ...markstream,
  enableKatex: () => {},
  enableMermaid: () => {},
}));
void mock.module('../src/lib/markdownWorkers', () => ({ ensureMarkdownWorkers: () => {} }));

const stub = stubGlobals();
const stubWindow = stubGlobals(window);

export function stubLayout(): void {
  stub('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  stubWindow('matchMedia', matchMedia);
  stub('matchMedia', matchMedia);
}

export async function waitForRender(check: () => void | Promise<void>, timeoutMs = 1000): Promise<void> {
  await until('markdown render', async () => {
    await check();
    return true;
  }, { timeoutMs });
}
