import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Plugin } from 'vite';

import packageJson from '../package.json' with { type: 'json' };

const WEB_USER_AGENT_PRODUCT = 'kimi-code-web';
const CLIENT_TO_SERVER_EVENT = 'kimi-code-web:client';
const SERVER_TO_CLIENT_EVENT = 'kimi-code-web:server';
const SDK_DIST_URL = pathToFileURL(
  resolve(process.cwd(), '../../packages/node-sdk/dist/index.mjs'),
).href;

interface KimiCoreBirpcServerRuntime {
  ensureConfigFile(): Promise<void>;
  close(): Promise<void>;
}

interface KimiCoreBirpcServerModule {
  readonly KimiCoreBirpcServer: new (options: {
    readonly channel: {
      post(data: unknown): void;
      on(fn: (data: unknown) => void): void;
    };
    readonly identity: {
      readonly userAgentProduct: string;
      readonly version: string;
    };
  }) => KimiCoreBirpcServerRuntime;
}

export function kimiCodeWebPlugin(): Plugin {
  return {
    name: 'kimi-code-web',
    async configureServer(server) {
      const { KimiCoreBirpcServer: KimiCoreBirpcServerCtor } = (await import(
        /* @vite-ignore */ SDK_DIST_URL
      )) as KimiCoreBirpcServerModule;
      const runtime = new KimiCoreBirpcServerCtor({
        channel: {
          post: (data) => server.ws.send(SERVER_TO_CLIENT_EVENT, data),
          on: (fn) => server.ws.on(CLIENT_TO_SERVER_EVENT, fn),
        },
        identity: {
          userAgentProduct: WEB_USER_AGENT_PRODUCT,
          version: packageJson.version,
        },
      });
      await runtime.ensureConfigFile();

      server.httpServer?.once('close', () => {
        void runtime.close();
      });
    },
  };
}
