import { randomBytes } from 'node:crypto';

import type { Session, WebContents } from 'electron';

let launchSecret: string | undefined;

export function desktopServerSecret(): string {
  launchSecret ??= randomBytes(32).toString('base64url');
  return launchSecret;
}

let embeddedOrigin: string | undefined;

export function setEmbeddedServerOrigin(origin: string | undefined): void {
  embeddedOrigin = origin;
}

const appWebContents = new Set<number>();

export function registerAppWebContents(contents: WebContents): void {
  appWebContents.add(contents.id);
  contents.once('destroyed', () => {
    appWebContents.delete(contents.id);
  });
}

function isEmbeddedServerUrl(url: string, origin: string): boolean {
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
    base = new URL(origin);
  } catch {
    return false;
  }
  if (target.host !== base.host) return false;
  return (
    target.protocol === 'http:' ||
    target.protocol === 'https:' ||
    target.protocol === 'ws:' ||
    target.protocol === 'wss:'
  );
}

const injectedSessions = new WeakSet<Session>();

export function installEmbeddedServerAuthInjection(ses: Session): void {
  if (injectedSessions.has(ses)) return;
  injectedSessions.add(ses);
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const origin = embeddedOrigin;
    const contents = details.webContents;
    if (
      origin !== undefined &&
      contents !== undefined &&
      appWebContents.has(contents.id) &&
      isEmbeddedServerUrl(details.url, origin)
    ) {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          Authorization: `Bearer ${desktopServerSecret()}`,
        },
      });
      return;
    }
    callback({});
  });
}
