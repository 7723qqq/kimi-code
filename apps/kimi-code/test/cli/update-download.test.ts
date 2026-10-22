import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import * as sdkModule from '@moonshot-ai/kimi-code-sdk';
import { createFakeClock, type FakeClock } from '#test/helpers/fake-clock';

import { createDownloadProgress, runUpdateDownloadCommand } from '#/cli/sub/update-download';
import type { NativeInstallDetection } from '#/cli/update/source';

/** Let the promise chains behind a settled clock tick run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

async function advanceAsync(clock: FakeClock, byMs: number): Promise<void> {
  await settle();
  clock.advance(byMs);
  await settle();
}

const mocks = (() => ({
  detectNativeInstall: mock(
    (): NativeInstallDetection => ({
      native: true,
      kind: 'sea',
    }),
  ),
  tryAcquireUpdateInstallLock: mock(),
  readUpdateInstallLockVersion: mock(),
  stageNativeUpdate: mock(),
  readStagedNativeUpdate: mock(),
  promoteStagedUpdateToManual: mock(async () => true),
  hashFileSha256: mock(),
  stagedExePath: mock(() => '/tmp/staged-exe'),
}))();

void mock.module('#/cli/update/source', () => ({
  detectNativeInstall: mocks.detectNativeInstall,
}));

void mock.module('#/cli/update/install-lock', () => ({
  tryAcquireUpdateInstallLock: mocks.tryAcquireUpdateInstallLock,
  readUpdateInstallLockVersion: mocks.readUpdateInstallLockVersion,
}));

void mock.module('#/cli/update/native-stage', () => ({
  stageNativeUpdate: mocks.stageNativeUpdate,
  readStagedNativeUpdate: mocks.readStagedNativeUpdate,
  promoteStagedUpdateToManual: mocks.promoteStagedUpdateToManual,
  hashFileSha256: mocks.hashFileSha256,
  stagedExePath: mocks.stagedExePath,
}));

void mock.module('@moonshot-ai/kimi-code-sdk', () => {
  return {
    ...sdkModule,
    log: { ...sdkModule.log, warn: mock() },
  };
});

function fakeOut(isTTY: boolean): { readonly out: NodeJS.WriteStream; readonly chunks: string[] } {
  const chunks: string[] = [];
  const out = {
    isTTY,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { out, chunks };
}

describe('createDownloadProgress', () => {
  it('renders a throttled in-place line on a TTY, with the final frame always shown', () => {
    const { out, chunks } = fakeOut(true);
    let clockMs = 1_000;
    const progress = createDownloadProgress(out, 'Downloading…', () => clockMs);
    const total = 100 * 1024 * 1024;

    progress(10 * 1024 * 1024, total);
    clockMs = 1_050; // inside the 100 ms throttle window → skipped
    progress(20 * 1024 * 1024, total);
    clockMs = 1_200;
    progress(30 * 1024 * 1024, total);
    progress(total, total); // final frame is never throttled

    expect(chunks).toEqual([
      '\r\u001B[KDownloading… 10% (10/100 MB)',
      '\r\u001B[KDownloading… 30% (30/100 MB)',
      '\r\u001B[KDownloading… 100% (100/100 MB)',
    ]);
  });

  it('prints the label up front and one line per 32 MB when piped', () => {
    const { out, chunks } = fakeOut(false);
    const progress = createDownloadProgress(out, 'Downloading…');
    const total = 100 * 1024 * 1024;

    progress(10 * 1024 * 1024, total); // below the 32 MB line interval → skipped
    progress(40 * 1024 * 1024, total);
    progress(total, total);

    expect(chunks).toEqual([
      'Downloading…\n',
      'Downloading… 40% (40/100 MB)\n',
      'Downloading… 100% (100/100 MB)\n',
    ]);
  });

  it('degrades to plain MB counts when Content-Length is unknown', () => {
    const { out, chunks } = fakeOut(true);
    const progress = createDownloadProgress(out, 'Downloading…');
    progress(5 * 1024 * 1024, null);
    expect(chunks).toEqual(['\r\u001B[KDownloading… 5 MB']);
  });
});

describe('runUpdateDownloadCommand', () => {
  const STAGED_HASH = 'a'.repeat(64);

  beforeEach(() => {
    mock.clearAllMocks();
    mocks.detectNativeInstall.mockReturnValue({ native: true, kind: 'sea' });
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue({
      filePath: '/tmp/install.lock',
      release: mock(async () => {}),
    });
    mocks.stageNativeUpdate.mockResolvedValue({ status: 'staged', staged: {} });
    mocks.hashFileSha256.mockResolvedValue(STAGED_HASH);
  });

  afterEach(() => {
    mock.restore();
  });

  const stagedRecord = (overrides: Record<string, unknown> = {}) => ({
    version: '0.7.0',
    target: 'win32-x64',
    exeFileName: 'kimi-0.7.0.4242.1700000000000.0.exe',
    sha256: STAGED_HASH,
    exeSize: 5,
    stagedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  });

  it('refuses on non-native installs', async () => {
    mocks.detectNativeInstall.mockReturnValue({ native: false });
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(1);
    expect(mocks.stageNativeUpdate).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('native build'));
  });

  it('waits for and adopts the result when another instance downloads the same version', async () => {
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue(null);
    mocks.readUpdateInstallLockVersion.mockResolvedValue('0.7.0');
    // The other worker's staged update is verified on disk on the first poll.
    mocks.readStagedNativeUpdate.mockResolvedValue({ version: '0.7.0', sha256: STAGED_HASH });
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('already in progress'));
    // A background waiter's adoption keeps the auto marker.
    expect(mocks.promoteStagedUpdateToManual).not.toHaveBeenCalled();
  });

  it('promotes the adopted stage to manual when an explicit upgrade waited for it', async () => {
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue(null);
    mocks.readUpdateInstallLockVersion.mockResolvedValue('0.7.0');
    mocks.readStagedNativeUpdate.mockResolvedValue({ version: '0.7.0', sha256: STAGED_HASH });
    spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(runUpdateDownloadCommand('0.7.0', true)).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).not.toHaveBeenCalled();
    expect(mocks.promoteStagedUpdateToManual).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting until the manual promotion is confirmed persisted', async () => {
    // The first promotion attempt loses a race with a concurrent swap's
    // claim/restore cycle; the loop must not report adoption until the
    // marker is confirmed.
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue(null);
    mocks.readUpdateInstallLockVersion.mockResolvedValue('0.7.0');
    mocks.readStagedNativeUpdate.mockResolvedValue({ version: '0.7.0', sha256: STAGED_HASH });
    mocks.promoteStagedUpdateToManual
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(runUpdateDownloadCommand('0.7.0', true)).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).not.toHaveBeenCalled();
    expect(mocks.promoteStagedUpdateToManual).toHaveBeenCalledTimes(2);
  });

  it('waits instead of adopting when the recorded payload fails the checksum', async () => {
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue(null);
    mocks.readUpdateInstallLockVersion.mockResolvedValue('0.7.0');
    mocks.readStagedNativeUpdate.mockResolvedValue({ version: '0.7.0', sha256: STAGED_HASH });
    // First poll: the recorded payload is corrupt (the holder is re-staging
    // it — its metadata is only replaced when the repaired generation
    // publishes); second poll: the repaired generation verifies.
    mocks.hashFileSha256.mockResolvedValueOnce('corrupt').mockResolvedValue(STAGED_HASH);
    spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).not.toHaveBeenCalled();
    expect(mocks.hashFileSha256).toHaveBeenCalledTimes(2);
  });

  it('takes over when the holder dies leaving a corrupt stage behind', async () => {
    const release = mock(async () => {});
    mocks.tryAcquireUpdateInstallLock
      .mockResolvedValueOnce(null) // initial acquire: held
      .mockResolvedValue({ filePath: '/tmp/install.lock', release }); // in-loop takeover
    mocks.readUpdateInstallLockVersion.mockResolvedValueOnce('0.7.0');
    mocks.readStagedNativeUpdate.mockResolvedValue({ version: '0.7.0', sha256: STAGED_HASH });
    // The recorded payload never verifies: the lock poll takes over and
    // stageNativeUpdate's own adoption check re-stages it.
    mocks.hashFileSha256.mockResolvedValue('corrupt');
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.7.0' }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('takes over when the same-version holder finishes without staging', async () => {
    const release = mock(async () => {});
    mocks.tryAcquireUpdateInstallLock
      .mockResolvedValueOnce(null) // held by the other worker…
      .mockResolvedValueOnce({ filePath: '/tmp/install.lock', release }); // …won inside the wait loop
    mocks.readUpdateInstallLockVersion.mockResolvedValueOnce('0.7.0'); // the initial holder check
    mocks.readStagedNativeUpdate.mockResolvedValue(null);
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.7.0' }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('hashes the staged payload once per generation instead of once per poll', async () => {
    // The waiter polls every 2 s while the holder works, and each poll used to
    // re-read and re-hash the ~180 MB payload. Nothing about the generation
    // changes, so the verified verdict must be reused for the whole wait.
    const clock = createFakeClock();
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue(null);
    mocks.readUpdateInstallLockVersion.mockResolvedValue('0.7.0');
    mocks.readStagedNativeUpdate.mockResolvedValue(stagedRecord());
    mocks.hashFileSha256.mockResolvedValue(STAGED_HASH);
    // A concurrent swap claim/restore cycle keeps the manual promotion from
    // persisting, so the waiter polls on and on.
    mocks.promoteStagedUpdateToManual.mockResolvedValue(false);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    spyOn(process.stdout, 'write').mockImplementation(() => true);
    const pending = runUpdateDownloadCommand('0.7.0', true, { clock });
    // Each poll arms the next one only after it settles, so advance window by window.
    for (let poll = 0; poll < 6; poll += 1) {
      await advanceAsync(clock, 2_000);
    }
    expect(mocks.readStagedNativeUpdate.mock.calls.length).toBeGreaterThan(4);
    expect(mocks.hashFileSha256).toHaveBeenCalledTimes(1);
    // The rest of the bounded wait still costs no further hashing.
    for (let window = 0; window < 120; window += 1) {
      await advanceAsync(clock, 4 * 60 * 1000);
      if (mocks.readStagedNativeUpdate.mock.calls.length > 200) break;
    }
    await expect(pending).resolves.toBe(1);
    expect(mocks.hashFileSha256).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('already downloading'));
  });

  it('hands the caller its error path when the wait outlives its deadline', async () => {
    // A holder that is alive but wedged keeps its lock fresh forever, so
    // nothing else would end this wait: without a deadline this poller (and a
    // foreground `kimi upgrade`) would run forever. The expired wait falls
    // through to the caller's existing "another update is already
    // downloading" failure instead of a success that never happened.
    const clock = createFakeClock();
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue(null);
    mocks.readUpdateInstallLockVersion.mockResolvedValue('0.7.0');
    mocks.readStagedNativeUpdate.mockResolvedValue(null);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    spyOn(process.stdout, 'write').mockImplementation(() => true);
    const pending = runUpdateDownloadCommand('0.7.0', undefined, { clock });
    await advanceAsync(clock, 7 * 60 * 60 * 1000);
    await expect(pending).resolves.toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('already downloading'));
    expect(mocks.stageNativeUpdate).not.toHaveBeenCalled();
  });

  it('fails instead of a false success when the lock holder stages another version', async () => {
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue(null);
    mocks.readUpdateInstallLockVersion.mockResolvedValue('0.8.0');
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(1);
    expect(mocks.stageNativeUpdate).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('0.8.0'));
  });

  it('retries the acquire when the lock vanished between the two reads', async () => {
    const release = mock(async () => {});
    mocks.tryAcquireUpdateInstallLock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ filePath: '/tmp/install.lock', release });
    mocks.readUpdateInstallLockVersion.mockResolvedValue(undefined);
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.7.0' }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('stages against the running exe and releases the lock', async () => {
    const release = mock(async () => {});
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue({ filePath: '/tmp/install.lock', release });
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.7.0', exePath: process.execPath }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('marks the stage as manual when the download answers an explicit upgrade', async () => {
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue({
      filePath: '/tmp/install.lock',
      release: mock(async () => {}),
    });
    await expect(runUpdateDownloadCommand('0.7.0', true)).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.7.0', manual: true }),
    );
  });

  it('passes the detected install kind as the staging engine', async () => {
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue({
      filePath: '/tmp/install.lock',
      release: mock(async () => {}),
    });

    mocks.detectNativeInstall.mockReturnValue({ native: true, kind: 'bun' });
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.7.0', engine: 'bun' }),
    );

    mocks.detectNativeInstall.mockReturnValue({ native: true, kind: 'sea' });
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: '0.7.0', engine: 'sea' }),
    );
  });

  it('reports staging failures with a non-zero exit code', async () => {
    mocks.stageNativeUpdate.mockRejectedValue(new Error('sha256 mismatch'));
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('sha256 mismatch'));
  });
});
