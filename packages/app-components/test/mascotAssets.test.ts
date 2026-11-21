import { expect, it } from 'bun:test';
import { createApp, h } from 'vue';
import { stubGlobals } from '../../vite-preset/test/globals';
import KimiMascot from '../src/KimiMascot.vue';

const stubWindow = stubGlobals(window);

it.each([
  ['../src/assets/mascot/kimi_avatar_default.riv', 'application/octet-stream'],
  ['@rive-app/canvas/rive.wasm', 'application/wasm'],
  ['@rive-app/canvas/rive_fallback.wasm', 'application/wasm'],
])('loads %s as an inline URL without changing its bytes', async (path, mime) => {
  const { default: url } = await import(`${path}?inline`);
  const prefix = `data:${mime};base64,`;
  expect(url.startsWith(prefix)).toBe(true);
  const original = await Bun.file(Bun.resolveSync(path, import.meta.dir)).bytes();
  expect(Buffer.from(url.slice(prefix.length), 'base64').equals(original)).toBe(true);
});

it('renders the mascot fallback when motion is reduced', () => {
  stubWindow('matchMedia', (media: string) => Object.assign(new EventTarget(), {
    media,
    matches: media === '(prefers-reduced-motion: reduce)',
  }));
  const app = createApp({ render: () => h(KimiMascot) });
  const host = document.createElement('div');
  app.mount(host);
  try {
    expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Kimi mascot');
    expect(host.querySelector('svg.mascot-fallback')).not.toBeNull();
  } finally {
    app.unmount();
  }
});
