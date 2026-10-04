import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Vitest's built-in jsdom environment constructs its JSDOM with
// `runScripts: "dangerously"`, which makes jsdom build the window in a `node:vm` context.
// Under the Bun runtime `vm.runInContext('this', vm.createContext(DONT_CONTEXTIFY))` is not
// the context object itself (Node: it is), so `dom.window` is a global proxy distinct from the
// contextified object jsdom stamped its `#impl` private-field brand onto. Installing the
// environment then calls `window.addEventListener.bind(window)`, the generated EventTarget
// method rejects the proxy's brand, and the worker never starts. These tests do not evaluate
// page scripts, so this environment mirrors vitest's jsdom setup but leaves `runScripts` unset,
// letting jsdom skip the vm context so `dom.window` is its own implementation object again.
export default {
  name: 'jsdom-bun',
  viteEnvironment: 'client' as const,
  setup(global: Record<string, any>, options: Record<string, any> = {}) {
    // Neither `jsdom` nor this `vitest/runtime` entry ships usable type declarations here.
    const { CookieJar, JSDOM } = require('jsdom') as {
      JSDOM: new (html: string, options: Record<string, any>) => { window: any };
      CookieJar: new () => unknown;
    };
    const { populateGlobal } = require('vitest/runtime') as {
      populateGlobal: (
        global: Record<string, any>,
        win: unknown,
        options?: { bindFunctions?: boolean },
      ) => { keys: string[]; originals: Map<string, unknown> };
    };

    const {
      html = '<!DOCTYPE html>',
      userAgent,
      url = 'http://localhost:3000',
      contentType = 'text/html',
      pretendToBeVisual = true,
      includeNodeLocations = false,
      cookieJar = false,
      ...restOptions
    } = options;

    const dom = new JSDOM(html, {
      pretendToBeVisual,
      url,
      includeNodeLocations,
      cookieJar: cookieJar ? new CookieJar() : undefined,
      contentType,
      userAgent,
      ...restOptions,
    });

    const { keys, originals } = populateGlobal(global, dom.window, { bindFunctions: true });
    global.jsdom = dom;

    return {
      teardown(target: Record<string, any>) {
        (dom.window as { close(): void }).close();
        delete target.jsdom;
        keys.forEach((key) => delete target[key]);
        originals.forEach((value, key) => {
          target[key] = value;
        });
      },
    };
  },
};
