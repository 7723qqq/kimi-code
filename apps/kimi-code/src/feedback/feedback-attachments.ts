import { createReadStream } from 'node:fs';
import { appendFile, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { detectInstallSource } from '#/cli/update/source';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { FeedbackAttachmentLevel } from '#/tui/commands/prompts';
import { getLogDir } from '#/utils/paths';
import { detectShellEnvironment } from '#/utils/process/shell-env';

import { createFeedbackArchivePath, type FeedbackArchive } from './archive';
import {
  packageCodebase,
  scanCodebase,
  type FeedbackCodebaseLimitExceeded,
  type FeedbackCodebaseScanResult,
} from './codebase';
import { MAX_ARCHIVE_SIZE, uploadArchive, type FeedbackUploadUrlApi } from './upload';

export const CODEBASE_ARCHIVE_FILENAME = 'repo.zip';
export const SESSION_ARCHIVE_FILENAME = 'session.zip';

const CODEBASE_SCAN_TIMEOUT_MS = 3000;

/**
 * Stage 3 of the `/feedback` flow: prepare and upload each requested attachment
 * independently. Attachment failures are non-fatal because the text feedback
 * already exists, but any requested artifact that cannot be prepared/uploaded
 * is reported as a partial attachment failure instead of silently downgrading
 * the request.
 *
 * `codebaseTruncated` reports the separate, non-failure outcome where the
 * codebase archive uploaded fine but the scan hit its file-count/archive-size
 * cap: the backend received a prefix of the repository, which the caller must
 * say out loud rather than folding into "attached".
 */
export interface FeedbackAttachmentOutcome {
  /** True when at least one requested attachment could not be prepared/uploaded. */
  readonly failed: boolean;
  readonly codebaseTruncated?: FeedbackCodebaseLimitExceeded;
}

export async function submitFeedbackWithAttachments(
  host: SlashCommandHost,
  feedbackId: number,
  level: FeedbackAttachmentLevel,
): Promise<FeedbackAttachmentOutcome> {
  const api = createFeedbackUploadApi(host);

  if (level === 'logs') {
    const uploaded = await prepareAndUploadSessionArchive(host, api, feedbackId);
    return { failed: !uploaded };
  }
  if (level === 'logs+codebase') {
    const [sessionDir, scan] = await Promise.all([
      resolveCurrentSessionDir(host),
      scanCodebaseForFeedback(host.state.appState.workDir),
    ]);
    const [uploadedSession, uploadedCodebase] = await Promise.all([
      prepareAndUploadSessionArchive(host, api, feedbackId, sessionDir),
      prepareAndUploadCodebaseArchive(api, feedbackId, scan),
    ]);
    return {
      failed: !uploadedSession || !uploadedCodebase,
      ...(scan?.exceedsLimit === undefined ? {} : { codebaseTruncated: scan.exceedsLimit }),
    };
  }
  return { failed: false };
}

async function prepareAndUploadSessionArchive(
  host: SlashCommandHost,
  api: FeedbackUploadUrlApi,
  feedbackId: number,
  knownSessionDir?: string,
): Promise<boolean> {
  const sessionDir = knownSessionDir ?? (await resolveCurrentSessionDir(host));
  if (sessionDir === undefined) {
    await logFeedbackUploadError(new Error('cannot locate the current session directory'));
    return false;
  }
  return uploadProducedArchive(api, feedbackId, SESSION_ARCHIVE_FILENAME, async (archivePath) => {
    const exported = await host.harness.exportSession({
      id: host.state.appState.sessionId,
      outputPath: archivePath,
      includeGlobalLog: true,
      version: host.state.appState.version,
      installSource: await detectInstallSource(),
      shellEnv: detectShellEnvironment(),
    });
    return archiveFromExportedSession(exported.zipPath);
  });
}

async function prepareAndUploadCodebaseArchive(
  api: FeedbackUploadUrlApi,
  feedbackId: number,
  scan: FeedbackCodebaseScanResult | undefined,
): Promise<boolean> {
  if (scan === undefined) return false;
  return uploadProducedArchive(api, feedbackId, CODEBASE_ARCHIVE_FILENAME, (archivePath) =>
    packageCodebase(scan, archivePath),
  );
}

/**
 * Shared lifecycle for a single attachment: create a temp archive path, let
 * `produce` write the archive to it, upload it, then always remove the temp
 * directory — even when `produce` or the upload throws. Both the session log
 * archive and the codebase archive flow through here so their cleanup and
 * error handling cannot drift apart. Every failure — including archive-path
 * creation — is contained here as a non-fatal partial failure.
 */
async function uploadProducedArchive(
  api: FeedbackUploadUrlApi,
  feedbackId: number,
  filename: string,
  produce: (archivePath: string) => Promise<FeedbackArchive>,
): Promise<boolean> {
  let cleanupDir: string | undefined;
  try {
    const target = await createFeedbackArchivePath(filename);
    cleanupDir = target.cleanupDir;
    const archive = await produce(target.archivePath);
    await uploadArchive(api, { ...archive, cleanupDir: target.cleanupDir }, feedbackId, {
      filename,
    });
    return true;
  } catch (error) {
    await logFeedbackUploadError(error);
    return false;
  } finally {
    if (cleanupDir !== undefined) {
      await rm(cleanupDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Digest an exported session zip without ever holding it in memory: the export
 * can be hundreds of MiB (it includes the global log), and the old
 * `readFile`-then-hash path grew the CLI's RSS by the whole file just to derive
 * two hashes. The size guard runs first so an over-limit archive fails before a
 * single byte is read — `uploadArchive` would only reject it after `produce().
 */
export async function archiveFromExportedSession(zipPath: string): Promise<FeedbackArchive> {
  const archiveStat = await stat(zipPath);
  if (archiveStat.size > MAX_ARCHIVE_SIZE) {
    throw new Error(
      `Failed to upload archive: size ${archiveStat.size} exceeds maximum allowed size ${MAX_ARCHIVE_SIZE}.`,
    );
  }
  const sha256 = new Bun.CryptoHasher('sha256');
  const fingerprint = new Bun.CryptoHasher('sha256');
  for await (const chunk of createReadStream(zipPath)) {
    sha256.update(chunk as Buffer);
    fingerprint.update(chunk as Buffer);
  }
  return {
    path: zipPath,
    size: archiveStat.size,
    sha256: sha256.digest('hex'),
    fingerprint: fingerprint.digest('hex'),
    fileCount: 1,
  };
}

async function resolveCurrentSessionDir(host: SlashCommandHost): Promise<string | undefined> {
  try {
    const sessions = await host.harness.listSessions({ workDir: host.state.appState.workDir });
    return sessions.find((session) => session.id === host.state.appState.sessionId)?.sessionDir;
  } catch {
    return undefined;
  }
}

async function scanCodebaseForFeedback(
  workDir: string,
): Promise<FeedbackCodebaseScanResult | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, CODEBASE_SCAN_TIMEOUT_MS);
  try {
    return await scanCodebase(workDir, { signal: controller.signal });
  } catch (error) {
    await logFeedbackUploadError(error);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function logFeedbackUploadError(error: unknown): Promise<void> {
  try {
    const logDir = getLogDir();
    await mkdir(logDir, { recursive: true });
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    await appendFile(
      join(logDir, 'feedback-upload.log'),
      `${new Date().toISOString()} ${message}\n`,
    );
  } catch {
    // best-effort logging only
  }
}

function createFeedbackUploadApi(host: SlashCommandHost): FeedbackUploadUrlApi {
  return {
    async createUploadUrl(input) {
      const res = await host.harness.auth.createFeedbackUploadUrl(input);
      if (res.kind !== 'ok') throw new Error(res.message);
      return {
        uploadId: res.uploadId,
        parts: res.parts,
      };
    },
    async completeUpload(input) {
      const res = await host.harness.auth.completeFeedbackUpload({
        uploadId: input.uploadId,
        parts: input.parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
      });
      if (res.kind !== 'ok') throw new Error(res.message);
    },
  };
}
