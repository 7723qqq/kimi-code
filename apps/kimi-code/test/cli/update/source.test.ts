import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyByPathHeuristic,
  classifyInstallSource,
  detectInstallSource,
  detectNativeInstall,
  type BunRuntimeView,
} from '#/cli/update/source';
import { resolveCommandPath } from '#/utils/process/resolve-command';

vi.mock('#/utils/process/resolve-command', () => ({
  resolveCommandPath: vi.fn(),
}));

describe('classifyByPathHeuristic', () => {
  it('returns null for an npm-style global path (handled by classifyInstallSource)', () => {
    expect(classifyByPathHeuristic('/usr/local/lib/node_modules/@moonshot-ai/kimi-code')).toBeNull();
  });

  it('detects yarn classic global', () => {
    expect(
      classifyByPathHeuristic('/Users/me/.config/yarn/global/node_modules/@moonshot-ai/kimi-code'),
    ).toBe('yarn-global');
  });

  it('detects yarn berry global (~/.yarn/global)', () => {
    expect(
      classifyByPathHeuristic('/Users/me/.yarn/global/node_modules/@moonshot-ai/kimi-code'),
    ).toBe('yarn-global');
  });

  it('detects bun global', () => {
    expect(
      classifyByPathHeuristic('/Users/me/.bun/install/global/node_modules/@moonshot-ai/kimi-code'),
    ).toBe('bun-global');
  });

  it('detects homebrew on macOS (Cellar path)', () => {
    expect(
      classifyByPathHeuristic('/opt/homebrew/Cellar/kimi-code/0.5.0/libexec/lib/node_modules/@moonshot-ai/kimi-code'),
    ).toBe('homebrew');
  });

  it('detects homebrew on Linux (Linuxbrew)', () => {
    expect(
      classifyByPathHeuristic('/home/linuxbrew/.linuxbrew/Cellar/kimi-code/0.5.0/libexec/lib/node_modules/@moonshot-ai/kimi-code'),
    ).toBe('homebrew');
  });

  it('does not treat npm-global under Homebrew prefix as homebrew', () => {
    expect(
      classifyByPathHeuristic('/opt/homebrew/lib/node_modules/@moonshot-ai/kimi-code'),
    ).toBeNull();
  });

  it('returns null for an unknown layout', () => {
    expect(classifyByPathHeuristic('/Users/me/dev/@moonshot-ai/kimi-code')).toBeNull();
  });
});

describe('classifyInstallSource (npm prefix matching)', () => {
  it('matches a macOS/Linux npm global package path', () => {
    expect(
      classifyInstallSource('/usr/local/lib/node_modules/@moonshot-ai/kimi-code', '/usr/local', 'darwin'),
    ).toBe('npm-global');
  });

  it('returns unsupported when the package path does not match the prefix', () => {
    expect(
      classifyInstallSource('/Users/me/dev/@moonshot-ai/kimi-code', '/usr/local', 'darwin'),
    ).toBe('unsupported');
  });
});

describe('detectInstallSource', () => {
  it('returns yarn-global when packageRoot matches yarn heuristic', async () => {
    await expect(
      detectInstallSource({
        getPackageRoot: () => '/Users/me/.config/yarn/global/node_modules/@moonshot-ai/kimi-code',
        getGlobalPrefix: async () => '/usr/local',
        detectNative: () => ({ native: false }),
        platform: 'darwin',
      }),
    ).resolves.toBe('yarn-global');
  });

  it('returns bun-global when packageRoot matches bun heuristic', async () => {
    await expect(
      detectInstallSource({
        getPackageRoot: () => '/Users/me/.bun/install/global/node_modules/@moonshot-ai/kimi-code',
        getGlobalPrefix: async () => '/usr/local',
        detectNative: () => ({ native: false }),
        platform: 'darwin',
      }),
    ).resolves.toBe('bun-global');
  });

  it('returns npm-global when packageRoot matches npm prefix', async () => {
    await expect(
      detectInstallSource({
        getPackageRoot: () => '/usr/local/lib/node_modules/@moonshot-ai/kimi-code',
        getGlobalPrefix: async () => '/usr/local',
        detectNative: () => ({ native: false }),
        platform: 'darwin',
      }),
    ).resolves.toBe('npm-global');
  });

  it('returns homebrew when packageRoot matches Cellar heuristic', async () => {
    await expect(
      detectInstallSource({
        getPackageRoot: () =>
          '/opt/homebrew/Cellar/kimi-code/0.5.0/libexec/lib/node_modules/@moonshot-ai/kimi-code',
        getGlobalPrefix: async () => '/usr/local',
        detectNative: () => ({ native: false }),
        platform: 'darwin',
      }),
    ).resolves.toBe('homebrew');
  });

  it('returns native when detectNative reports a packaged SEA-era install (highest priority)', async () => {
    await expect(
      detectInstallSource({
        getPackageRoot: () => '/usr/local/lib/node_modules/@moonshot-ai/kimi-code',
        getGlobalPrefix: async () => '/usr/local',
        detectNative: () => ({ native: true, kind: 'sea' }),
        platform: 'darwin',
      }),
    ).resolves.toBe('native');
  });

  it('returns native for a packaged Bun install', async () => {
    await expect(
      detectInstallSource({
        getPackageRoot: () => '/usr/local/lib/node_modules/@moonshot-ai/kimi-code',
        getGlobalPrefix: async () => '/usr/local',
        detectNative: () => ({ native: true, kind: 'bun' }),
        platform: 'darwin',
      }),
    ).resolves.toBe('native');
  });

  it('returns unsupported when nothing matches', async () => {
    await expect(
      detectInstallSource({
        getPackageRoot: () => '/Users/me/dev/@moonshot-ai/kimi-code',
        getGlobalPrefix: async () => '/usr/local',
        detectNative: () => ({ native: false }),
        platform: 'darwin',
      }),
    ).resolves.toBe('unsupported');
  });

  it('returns unsupported when npm prefix lookup throws', async () => {
    await expect(
      detectInstallSource({
        getPackageRoot: () => '/Users/me/dev/@moonshot-ai/kimi-code',
        getGlobalPrefix: async () => {
          throw new Error('prefix failed');
        },
        detectNative: () => ({ native: false }),
        platform: 'darwin',
      }),
    ).resolves.toBe('unsupported');
  });

  it('returns unsupported when npm cannot be resolved outside the cwd', async () => {
    // The default prefix lookup spawns npm; when it can only be found inside
    // the current directory (or not at all), detection must degrade to
    // 'unsupported' rather than run a planted binary.
    vi.mocked(resolveCommandPath).mockReturnValue(undefined);
    await expect(
      detectInstallSource({
        getPackageRoot: () => '/Users/me/dev/@moonshot-ai/kimi-code',
        detectNative: () => ({ native: false }),
        platform: 'darwin',
      }),
    ).resolves.toBe('unsupported');
    expect(resolveCommandPath).toHaveBeenCalledWith('npm');
  });
});

describe('detectNativeInstall', () => {
  it('reports a bun packaged install when the Bun runtime carries embedded assets', () => {
    expect(
      detectNativeInstall({
        Bun: { version: '1.3.0' },
        __KIMI_BUN_ASSETS__: { 'runtime/main.cjs': '/tmp/main.cjs' },
      }),
    ).toEqual({ native: true, kind: 'bun' });
  });

  it('stays non-native when Bun runs without embedded assets (a dev checkout)', () => {
    expect(detectNativeInstall({ Bun: { version: '1.3.0' } })).toEqual({ native: false });
  });

  it('ignores an empty embedded-asset map', () => {
    expect(
      detectNativeInstall({ Bun: { version: '1.3.0' }, __KIMI_BUN_ASSETS__: {} }),
    ).toEqual({ native: false });
  });

  it('does not treat the asset marker alone as native outside the Bun runtime', () => {
    expect(
      detectNativeInstall({ __KIMI_BUN_ASSETS__: { 'runtime/main.cjs': '/tmp/main.cjs' } }),
    ).toEqual({ native: false });
  });

  it('reads the live globalThis when no view is injected', () => {
    const view = globalThis as BunRuntimeView;
    // Whatever the host runtime is, the default view must agree with it:
    // a packaged bun binary reports bun, everything else reports non-native.
    expect(detectNativeInstall()).toEqual(
      view.Bun !== undefined && view.__KIMI_BUN_ASSETS__ !== undefined &&
          Object.keys(view.__KIMI_BUN_ASSETS__).length > 0
        ? { native: true, kind: 'bun' }
        : { native: false },
    );
  });
});
