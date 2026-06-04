/// <reference types="vite/client" />

declare const __KIMI_CODE_WEB_WORK_DIR__: string;
declare const __KIMI_CODE_WEB_VERSION__: string;

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<object, object, unknown>;
  export default component;
}

declare module 'vite/types/customEvent' {
  interface CustomEventMap {
    'kimi-code-web:client': unknown;
    'kimi-code-web:server': unknown;
  }
}
