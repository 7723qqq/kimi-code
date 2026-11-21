import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const STALE_ARCHIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface FeedbackArchive {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly fingerprint: string;
  readonly fileCount: number;
  readonly cleanupDir?: string;
}

export async function createFeedbackArchivePath(
  filename: string,
  cacheDir: string,
): Promise<{
  readonly archivePath: string;
  readonly cleanupDir: string;
}> {
  const archivePath = await createArchivePath(filename, cacheDir);
  return { archivePath, cleanupDir: archivePathCleanupDir(archivePath) };
}

export async function removeStaleFeedbackUploads(options: {
  readonly now?: number;
  readonly dir: string;
}): Promise<void> {
  const now = options.now ?? Date.now();
  const dir = options.dir;
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (entries === null) return;

  const cutoff = now - STALE_ARCHIVE_MAX_AGE_MS;
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) return;
      const target = join(dir, entry.name);
      const targetStat = await stat(target).catch(() => null);
      if (targetStat === null || targetStat.mtimeMs >= cutoff) return;
      await rm(target, { recursive: true, force: true }).catch(() => {});
    }),
  );
}

async function createArchivePath(filename: string, cacheDir: string): Promise<string> {
  const root = join(cacheDir, 'feedback-uploads');
  await removeStaleFeedbackUploads({ dir: root });
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'upload-'));
  return join(dir, filename);
}

function archivePathCleanupDir(archivePath: string): string {
  return dirname(archivePath);
}
