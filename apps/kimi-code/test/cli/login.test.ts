/**
 * `kimi login`
 *
 * Verifies that the login sub-command is registered on the program and
 * that the action drives `harness.auth.login`, prints the device code to
 * stderr, and exits with the right code on success / failure.
 */

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Mock } from 'bun:test';

import { OAuthAccessDeniedError } from '@moonshot-ai/kimi-code-oauth';
import * as sdkModule from '@moonshot-ai/kimi-code-sdk';

const mockLogin = mock();

void mock.module('@moonshot-ai/kimi-code-sdk', () => {
  return {
    ...sdkModule,
    createKimiHarness: mock(() => ({
      auth: {
        login: mockLogin,
      },
      getConfig: mock(async () => ({ providers: {}, models: {} })),
      setConfig: mock(async () => {}),
    })),
  };
});

void mock.module('#/utils/open-url', () => ({ openUrl: mock() }));

import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { registerLoginCommand } from '#/cli/sub/login';
import { openUrl } from '#/utils/open-url';

// The mocked exports keep their real signatures, so the assertions need the mock surface.
const openUrlMock = openUrl as unknown as Mock<typeof openUrl>;
const createKimiHarnessMock = createKimiHarness as unknown as Mock<typeof createKimiHarness>;

class ExitCalled extends Error {
  constructor(public code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

describe('kimi login', () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockLogin.mockReset();
    openUrlMock.mockReset();
    createKimiHarnessMock.mockClear();
    exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new ExitCalled(code);
    }) as never);
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('registers a `login` subcommand on the program', () => {
    const program = new Command('kimi');
    registerLoginCommand(program);

    const login = program.commands.find((c) => c.name() === 'login');
    expect(login).toBeDefined();
    expect(login?.description()).toMatch(/[Aa]uthenticat/);
  });

  it('invokes harness.auth.login and exits 0 on success', async () => {
    mockLogin.mockResolvedValue({ providerName: 'kimi-code', ok: true });

    const program = new Command('kimi').exitOverride();
    registerLoginCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'login'])).rejects.toThrow(ExitCalled);

    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(mockLogin).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onDeviceCode: expect.any(Function),
      }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('prints device code prompt to stderr', async () => {
    mockLogin.mockImplementation(
      async (
        _providerName: string | undefined,
        options: {
          onDeviceCode?: (data: {
            userCode: string;
            verificationUri: string;
            verificationUriComplete: string;
            expiresIn: number | null;
          }) => void | Promise<void>;
        },
      ) => {
        await options.onDeviceCode?.({
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://example.com/v',
          verificationUriComplete: 'https://example.com/v?code=ABCD-EFGH',
          expiresIn: 600,
        });
        return { providerName: 'kimi-code', ok: true };
      },
    );

    const program = new Command('kimi').exitOverride();
    registerLoginCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'login'])).rejects.toThrow(ExitCalled);

    const writtenChunks = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(writtenChunks.some((chunk: string) => chunk.includes('ABCD-EFGH'))).toBe(true);
    expect(writtenChunks.some((chunk: string) => chunk.includes('https://example.com/v'))).toBe(
      true,
    );
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/v?code=ABCD-EFGH');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('still prints device code prompt when opening the browser fails', async () => {
    openUrlMock.mockImplementation(() => {
      throw new Error('no browser');
    });
    mockLogin.mockImplementation(
      async (
        _providerName: string | undefined,
        options: {
          onDeviceCode?: (data: {
            userCode: string;
            verificationUri: string;
            verificationUriComplete: string;
            expiresIn: number | null;
          }) => void | Promise<void>;
        },
      ) => {
        await options.onDeviceCode?.({
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://example.com/v',
          verificationUriComplete: 'https://example.com/v?code=ABCD-EFGH',
          expiresIn: 600,
        });
        return { providerName: 'kimi-code', ok: true };
      },
    );

    const program = new Command('kimi').exitOverride();
    registerLoginCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'login'])).rejects.toThrow(ExitCalled);

    const writtenChunks = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(writtenChunks.some((chunk: string) => chunk.includes('ABCD-EFGH'))).toBe(true);
    expect(writtenChunks.some((chunk: string) => chunk.includes('https://example.com/v'))).toBe(
      true,
    );
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/v?code=ABCD-EFGH');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 when auth.login throws', async () => {
    mockLogin.mockRejectedValue(new Error('boom'));

    const program = new Command('kimi').exitOverride();
    registerLoginCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'login'])).rejects.toThrow(ExitCalled);

    const writtenChunks = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(writtenChunks.some((chunk: string) => chunk.includes('boom'))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints "Login cancelled" with the original message when the user denies authorization', async () => {
    mockLogin.mockRejectedValue(
      new OAuthAccessDeniedError('Authorization denied: The resource owner denied the request'),
    );

    const program = new Command('kimi').exitOverride();
    registerLoginCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'login'])).rejects.toThrow(ExitCalled);

    const writtenChunks = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(
      writtenChunks.some((chunk: string) =>
        chunk.includes('Login cancelled: Authorization denied: The resource owner denied the request'),
      ),
    ).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('drives Google login flow when --provider google is passed', async () => {
    const mockStartLoginFlow = mock().mockImplementation(async (options: { onAuthUrl?: (data: { authUrl: string }) => void }) => {
      options.onAuthUrl?.({ authUrl: 'https://accounts.google.com/o/oauth2/auth?test=1' });
      return { providerName: 'google-gemini', ok: true };
    });

    const oauthModule = await import('@moonshot-ai/kimi-code-oauth');
    spyOn(oauthModule.GoogleOAuthManager, 'detectAntigravityCredentials').mockReturnValue({ available: false });
    // Keep the real class (the static above lives on it) and stub the one
    // instance method the flow drives.
    spyOn(oauthModule.GoogleOAuthManager.prototype, 'startLoginFlow').mockImplementation(
      mockStartLoginFlow as unknown as () => never,
    );

    const program = new Command('kimi').exitOverride();
    registerLoginCommand(program);

    await expect(
      program.parseAsync(['node', 'kimi', 'login', '--provider', 'google']),
    ).rejects.toThrow(ExitCalled);

    expect(mockStartLoginFlow).toHaveBeenCalledTimes(1);
    expect(openUrlMock).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth?test=1');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('drives Antigravity sync flow when --provider antigravity is passed', async () => {
    const oauthModule = await import('@moonshot-ai/kimi-code-oauth');
    spyOn(oauthModule.GoogleOAuthManager, 'detectAntigravityCredentials').mockReturnValue({
      available: true,
      email: 'test@gmail.com',
      credsPath: '/mock/creds.json',
    });
    const mockImport = mock().mockResolvedValue({ accessToken: 'test-token' });
    spyOn(oauthModule.GoogleOAuthManager.prototype, 'importAntigravityCredentials').mockImplementation(
      mockImport as unknown as () => never,
    );

    const program = new Command('kimi').exitOverride();
    registerLoginCommand(program);

    await expect(
      program.parseAsync(['node', 'kimi', 'login', '--provider', 'antigravity']),
    ).rejects.toThrow(ExitCalled);

    expect(mockImport).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});


