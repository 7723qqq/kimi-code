/**
 * Platform dispatcher for the OS service manager.
 *
 * Phase 3 lands the darwin backend; Phase 4 systemd; Phase 5 schtasks. Until
 * a platform's backend is wired in, the dispatcher returns a stub manager
 * that throws `ServiceUnsupportedError` for every operation.
 *
 * Lazy-load the per-platform module so the bundle for one platform doesn't
 * carry the other two backends' XML / plist string templates.
 */

import { createLaunchdManager } from './launchd';
import { createSchtasksManager } from './schtasks';
import { createSystemdManager } from './systemd';
import { ServiceUnsupportedError, type ServiceManager } from './types';

export function resolveServiceManager(platform: NodeJS.Platform = process.platform): ServiceManager {
  switch (platform) {
    case 'darwin':
      return createLaunchdManager();
    case 'linux':
      return createSystemdManager();
    case 'win32':
      return createSchtasksManager();
    default:
      return createUnsupportedManager(platform);
  }
}

/**
 * Fallback manager used until a real backend is wired in.
 *
 * Every method throws — the CLI catches `ServiceUnsupportedError` and exits 2
 * with a friendly message.
 */
function createUnsupportedManager(platform: string): ServiceManager {
  const fail = (): never => {
    throw new ServiceUnsupportedError(platform);
  };
  return {
    install: async () => fail(),
    uninstall: async () => fail(),
    start: async () => fail(),
    stop: async () => fail(),
    restart: async () => fail(),
    status: async () => fail(),
  };
}
