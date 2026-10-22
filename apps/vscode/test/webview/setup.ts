import { afterAll, afterEach } from 'bun:test';
import { JSDOM } from 'jsdom';

// Bun has no `environment` option, so a suite that needs a document imports this module
// instead of configuring one. A `bunfig.toml` preload would apply to every file, and the
// extension tests must not see a `document` — a leaked one makes the SDK believe it runs
// in a browser — so the webview tests opt in by importing this file. It removes the
// globals again when the file finishes.
//
// Do not pass `runScripts: 'dangerously'`. That makes jsdom build its window in a
// `node:vm` context, and under Bun `vm.runInContext('this', vm.createContext(...))` is a
// global proxy rather than the context object itself. `dom.window` would then differ from
// the object jsdom branded for its private fields, and jsdom's own `EventTarget` rejects
// that proxy from `addEventListener` on, so the window never becomes usable. These tests
// evaluate no page scripts, so leaving `runScripts` unset keeps `dom.window` as the
// implementation object jsdom stamped.
const CORE_GLOBALS = ['window', 'document', 'navigator'] as const;

let installed: { keys: string[]; replaced: Map<string, unknown>; dom: JSDOM } | undefined;

function installDom(): void {
  if (installed) return;

  const dom = new JSDOM('<!DOCTYPE html>', { url: 'http://localhost:3000', pretendToBeVisual: true });
  const source = dom.window as unknown as Record<string, unknown>;
  const target = globalThis as Record<string, unknown>;

  const keys: string[] = [];
  const replaced = new Map<string, unknown>();

  // `window`, `document` and `navigator` are the roots the React tests need. `navigator`
  // already exists on Bun's global — the rest do not — so the originals are kept aside
  // for the teardown below.
  for (const key of CORE_GLOBALS) {
    if (key in target) replaced.set(key, target[key]);
    target[key] = source[key];
    keys.push(key);
  }

  // Everything else the document API surface needs (`HTMLElement`, `Node`,
  // `getComputedStyle`, `localStorage`, ...). Keys Bun already owns (`fetch`, `URL`,
  // `Event`, `setTimeout`, ...) keep Bun's implementation.
  for (const key of Object.getOwnPropertyNames(source)) {
    if (keys.includes(key) || key in target) continue;
    const value = source[key];
    target[key] = typeof value === 'function' ? value.bind(dom.window) : value;
    keys.push(key);
  }

  installed = { keys, replaced, dom };
}

installDom();

// React DOM and `@testing-library/dom` read `document` when first evaluated. A suite that
// drives input events has to load them itself, after this module has installed the globals
// (a static import here would be evaluated first, before `installDom()` runs) — loaded early,
// React takes its legacy IE event path, `attachEvent` on jsdom elements, and `onChange` never
// fires. This module therefore only reaches into it from the hooks below.
afterEach(async () => {
  const { cleanup } = await import('@testing-library/react');
  cleanup();
});

afterAll(() => {
  if (!installed) return;
  const target = globalThis as Record<string, unknown>;
  for (const key of installed.keys) {
    if (installed.replaced.has(key)) target[key] = installed.replaced.get(key);
    else delete target[key];
  }
  installed.dom.window.close();
  installed = undefined;
});
