/* oxlint-disable typescript-eslint/unbound-method -- the saved native method is invoked with an explicit receiver. */
import { afterAll } from 'bun:test';

import { JSDOM } from 'jsdom';

const { window } = new JSDOM('<!doctype html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
window.matchMedia = (media) =>
  Object.assign(new window.EventTarget(), {
    media,
    matches: false,
    onchange: null,
    addListener(listener) {
      this.addEventListener('change', listener);
    },
    removeListener(listener) {
      this.removeEventListener('change', listener);
    },
  });
const nativeMatches = window.Element.prototype.matches;
window.Element.prototype.matches = function matches(selector) {
  if (selector === ':focus-visible') return this.ownerDocument.activeElement === this;
  return nativeMatches.call(this, selector);
};
const globals = new Map();
const sharedGlobals = new Set([
  'window',
  'document',
  'navigator',
  'Event',
  'EventTarget',
  'CustomEvent',
  'MessageEvent',
  'Worker',
]);
for (const name of new Set([...Object.getOwnPropertyNames(window), ...sharedGlobals])) {
  if (name in globalThis && !sharedGlobals.has(name)) continue;
  const value = window[name];
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: /^(getComputedStyle|requestAnimationFrame|cancelAnimationFrame)$/.test(name)
      ? value.bind(window)
      : value,
  });
}

afterAll(() => {
  window.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
