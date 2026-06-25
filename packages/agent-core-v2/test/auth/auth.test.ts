import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IOAuthService } from '#/auth/auth';
import { IConfigService } from '#/config/config';
import { IEnvironmentService } from '#/environment/environment';
import { ITelemetryService } from '#/telemetry/telemetry';

import { OAuthService } from '#/auth/authService';

describe('OAuthService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IConfigService, {});
    ix.stub(IEnvironmentService, {});
    ix.stub(ITelemetryService, {});
    ix.set(IOAuthService, new SyncDescriptor(OAuthService));
  });
  afterEach(() => disposables.dispose());

  it('login / status / logout', async () => {
    const svc = ix.get(IOAuthService);
    expect(await svc.status()).toEqual({ loggedIn: false });
    await svc.login('kimi');
    expect(await svc.status()).toEqual({ loggedIn: true, provider: 'kimi' });
    await svc.logout('kimi');
    expect(await svc.status()).toEqual({ loggedIn: false });
  });
});
