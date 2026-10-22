/**
 * Hidden `kimi __update_download <version>` sub-command: the self-spawned
 * worker behind native staged updates. Preflight spawns it detached in the
 * background (and the `upgrade` command in the foreground); it downloads,
 * verifies and stages the binary next to the running exe. The swap into
 * place happens on the next startup (see `cli/update/native-swap.ts`).
 */

import { log } from '@moonshot-ai/kimi-code-sdk';

import {
  readUpdateInstallLockVersion,
  tryAcquireUpdateInstallLock,
  type UpdateInstallLockHandle,
} from '#/cli/update/install-lock';
import {
  hashFileSha256,
  promoteStagedUpdateToManual,
  readStagedNativeUpdate,
  stagedExePath,
  stageNativeUpdate,
} from '#/cli/update/native-stage';
import { detectNativeInstall } from '#/cli/update/source';
import { t } from '#/i18n';
import { SYSTEM_RENDER_CLOCK, type RenderClock } from '#/tui/utils/render-clock';

const LOCK_HELD_POLL_INTERVAL_MS = 2_000;

/**
 * Upper bound on the wait for another worker's stage. Only its holder's DEATH
 * ends the wait early (its lock then goes stale — see install-lock): a holder
 * alive but wedged keeps its lock fresh forever, so without a bound this loop
 * — and a foreground `kimi upgrade` waiting in it — never returns. A slow
 * link legitimately takes hours (the download is idle-bounded, not
 * duration-bounded), so the bound is deliberately generous: it only ends a
 * wait that has stopped being an update and become a leak.
 */
const STAGE_WAIT_MAX_MS = 6 * 60 * 60 * 1000;

/** The stage record fields that identify one published generation. */
type StagedGeneration = {
  readonly exeFileName: string;
  readonly sha256: string;
  readonly stagedAt: string;
};

type StagedUpdateWait =
  | { readonly status: 'staged' }
  | { readonly status: 'takeover'; readonly lock: UpdateInstallLockHandle | null };

/**
 * Another worker holds the install lock for the SAME version. Returning right
 * away would report a success that has not happened yet — the in-flight
 * download may still fail — so wait for it: 'staged' once its staged update is
 * verified on disk; 'takeover' once the lock becomes acquirable, with the lock
 * already held for the caller. The lock goes stale the moment its holder dies
 * (see install-lock), so a killed downloader cannot strand a foreground
 * `kimi upgrade` in this loop.
 *
 * Adoption applies the same integrity bar as stageNativeUpdate's
 * already-staged path: the recorded size proves nothing, and the holder may
 * still be RE-STAGING a same-size-corrupted payload (its metadata is only
 * replaced when the new generation publishes). A recorded stage whose payload
 * fails the checksum is treated as not-yet-staged — the lock poll below takes
 * over once the holder finishes without repairing it.
 *
 * A manual (explicit-upgrade) waiter adopts only after CONFIRMING the manual
 * marker landed on the stage — a concurrent startup swap may be claiming and
 * restoring the metadata right now, and reporting adoption for a promotion
 * that never persisted would strand the update under the env opt-out.
 */
async function waitForStagedUpdate(
  version: string,
  exePath: string,
  manual: boolean,
  clock: RenderClock,
): Promise<StagedUpdateWait> {
  const deadline = clock.now() + STAGE_WAIT_MAX_MS;
  // Identity of the generation whose payload the last hash verified. A stage
  // publishes its payload BEFORE the metadata pointing at it and a published
  // payload is never replaced, so a record with an unchanged identity still
  // describes exactly the bytes that verified — hashing costs one pass per
  // generation instead of one per poll (the payload is ~180 MB, the poll 2 s).
  // Only VERIFIED verdicts are cached: an unverified one is re-read every
  // poll, since the holder may be repairing that very generation in place
  // (only the metadata write retargets the record).
  let hashedGeneration: StagedGeneration | null = null;
  for (;;) {
    const staged = await readStagedNativeUpdate(exePath);
    let verified = false;
    if (staged !== null && staged.version === version) {
      const identity: StagedGeneration = {
        exeFileName: staged.exeFileName,
        sha256: staged.sha256,
        stagedAt: staged.stagedAt,
      };
      if (
        hashedGeneration !== null &&
        hashedGeneration.exeFileName === identity.exeFileName &&
        hashedGeneration.sha256 === identity.sha256 &&
        hashedGeneration.stagedAt === identity.stagedAt
      ) {
        verified = true;
      } else {
        verified = (await hashFileSha256(stagedExePath(exePath, staged))) === staged.sha256;
        hashedGeneration = verified ? identity : null;
      }
    }
    if (staged !== null && verified) {
      if (!manual || (await promoteStagedUpdateToManual(exePath, staged))) {
        return { status: 'staged' };
      }
      // The stage is being claimed/restored by a concurrent swap — the next
      // poll either promotes the restored stage or takes over once it is
      // gone.
    } else {
      // Poll the acquisition itself: while the holder lives its lock stays
      // fresh and this returns null without side effects; when the holder
      // finishes (or dies) without staging a VERIFIED payload, the takeover
      // happens right here.
      const lock = await tryAcquireUpdateInstallLock({ version });
      if (lock !== null) return { status: 'takeover', lock };
    }
    await new Promise((resolve) => {
      clock.setTimeout(() => {
        resolve(undefined);
      }, LOCK_HELD_POLL_INTERVAL_MS);
    });
    if (clock.now() >= deadline) {
      // Out of time: hand the caller the same outcome a released lock
      // produces — a final acquire that reports the surviving holder as
      // `null` (its error path) instead of polling forever.
      return { status: 'takeover', lock: await tryAcquireUpdateInstallLock({ version }) };
    }
  }
}

export interface UpdateDownloadDeps {
  /** Clock driving the wait-for-holder poll; defaults to the system clock. */
  readonly clock?: RenderClock;
}

export async function runUpdateDownloadCommand(
  version: string,
  manual: boolean = false,
  deps: UpdateDownloadDeps = {},
): Promise<number> {
  const clock = deps.clock ?? SYSTEM_RENDER_CLOCK;
  const install = detectNativeInstall();
  if (!install.native) {
    process.stderr.write(t('tui.statusMessages.updateDownloadNativeOnly') + '\n');
    return 1;
  }
  const out = process.stdout;
  let lock = await tryAcquireUpdateInstallLock({ version });
  if (lock === null) {
    const holderVersion = await readUpdateInstallLockVersion();
    if (holderVersion === version) {
      // Another worker is already downloading this exact version: wait for it
      // and adopt its verified result instead of exiting on a maybe.
      out.write(t('tui.statusMessages.updateDownloadInProgress', { version }) + '\n');
      const wait = await waitForStagedUpdate(version, process.execPath, manual, clock);
      if (wait.status === 'staged') {
        out.write(t('tui.statusMessages.updateDownloadStaged', { version }) + '\n');
        return 0;
      }
      // The holder finished without staging (failed or died): take over. The
      // lock may already be held by another winner of the takeover race —
      // the null check below reports that as held.
      lock = wait.lock;
    } else if (holderVersion === undefined) {
      // The lock was released between the two reads — retry the acquire once.
      lock = await tryAcquireUpdateInstallLock({ version });
    }
    if (lock === null) {
      process.stderr.write(
        t('tui.statusMessages.updateDownloadOtherInProgress', {
          version: holderVersion ?? t('tui.statusMessages.updateDownloadUnknownVersion'),
        }) + '\n',
      );
      return 1;
    }
  }
  const label = t('tui.statusMessages.updateDownloadLabel', {
    version,
    platform: process.platform,
    arch: process.arch,
  });
  const onProgress = createDownloadProgress(out, label);
  try {
    const result = await stageNativeUpdate({
      version,
      exePath: process.execPath,
      engine: install.kind,
      onProgress,
      manual,
    });
    if (out.isTTY) out.write('\n');
    if (result.status === 'already-staged') {
      out.write(t('tui.statusMessages.updateDownloadAlreadyStaged', { version }) + '\n');
    }
    return 0;
  } catch (error) {
    if (out.isTTY) out.write('\n');
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(t('tui.statusMessages.updateDownloadFailed', { version, message }) + '\n');
    log.warn('native update download failed', { version, error: message });
    return 1;
  } finally {
    await lock.release().catch(() => {});
  }
}

const PROGRESS_FRAME_INTERVAL_MS = 100;
const PROGRESS_LINE_INTERVAL_BYTES = 32 * 1024 * 1024;

function formatDownloadProgress(label: string, downloaded: number, total: number | null): string {
  const mb = Math.floor(downloaded / (1024 * 1024));
  if (total === null || total <= 0) return `${label} ${mb} MB`;
  const totalMb = Math.max(1, Math.round(total / (1024 * 1024)));
  const percent = Math.min(100, Math.floor((downloaded / total) * 100));
  return `${label} ${percent}% (${mb}/${totalMb} MB)`;
}

/**
 * Download progress renderer for the (foreground) downloader: a single
 * in-place line on a TTY (`\r` + clear-line, throttled to 10 fps, final frame
 * always rendered), or one line per 32 MB when piped to a file. The caller
 * owns the trailing newline. `now` is injectable so the throttle is testable
 * without a faked `Date`.
 */
export function createDownloadProgress(
  out: NodeJS.WriteStream,
  label: string,
  now: () => number = Date.now,
): (downloadedBytes: number, totalBytes: number | null) => void {
  const isTTY = out.isTTY;
  let lastFrameAt = 0;
  let lastLineAt = 0;
  if (!isTTY) out.write(`${label}\n`);
  return (downloaded, total) => {
    const done = total !== null && downloaded >= total;
    if (isTTY) {
      const current = now();
      if (!done && current - lastFrameAt < PROGRESS_FRAME_INTERVAL_MS) return;
      lastFrameAt = current;
      out.write(`\r\u001B[K${formatDownloadProgress(label, downloaded, total)}`);
      return;
    }
    if (!done && downloaded - lastLineAt < PROGRESS_LINE_INTERVAL_BYTES) return;
    lastLineAt = downloaded;
    out.write(`${formatDownloadProgress(label, downloaded, total)}\n`);
  };
}
