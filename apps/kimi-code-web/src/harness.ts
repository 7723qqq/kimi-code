import { createBirpcKimiHarness, type KimiHarness } from '@moonshot-ai/kimi-code-sdk/browser';

const WEB_USER_AGENT_PRODUCT = 'kimi-code-web';
const WEB_UI_MODE = 'web';
const CLIENT_TO_SERVER_EVENT = 'kimi-code-web:client';
const SERVER_TO_CLIENT_EVENT = 'kimi-code-web:server';

export function createKimiWebHarness(): KimiHarness {
  const hot = import.meta.hot;
  if (hot === undefined) {
    throw new Error('Kimi Code Web requires the Vite dev server.');
  }

  return createBirpcKimiHarness({
    channel: {
      post: (data) => {
        hot.send(CLIENT_TO_SERVER_EVENT, data);
      },
      on: (fn) => {
        hot.on(SERVER_TO_CLIENT_EVENT, fn);
      },
      off: (fn) => {
        hot.off(SERVER_TO_CLIENT_EVENT, fn);
      },
    },
    identity: {
      userAgentProduct: WEB_USER_AGENT_PRODUCT,
      version: __KIMI_CODE_WEB_VERSION__,
    },
    uiMode: WEB_UI_MODE,
  });
}
