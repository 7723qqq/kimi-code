import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { type Entry, fromBuffer as yauzlFromBuffer } from 'yauzl';

import { Error2, ErrorCodes } from '#/errors';

const MAX_ZIP_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_EXTRACTED_BYTES = 256 * 1024 * 1024;

export async function downloadZip(url: string, signal?: AbortSignal): Promise<Buffer> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => {
      controller.abort();
    },
    5 * 60 * 1000,
  );
  try {
    const resp = await fetch(url, { signal: signal ?? controller.signal });
    if (!resp.ok) {
      throw new Error2(
        ErrorCodes.PLUGIN_LOAD_FAILED,
        `Failed to download zip: HTTP ${resp.status} ${resp.statusText}`,
        { details: { url, status: resp.status } },
      );
    }
    const contentLength = Number(resp.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_ZIP_DOWNLOAD_BYTES) {
      await resp.body?.cancel().catch(() => {});
      throw new Error2(
        ErrorCodes.PLUGIN_LOAD_FAILED,
        `Zip download too large: ${String(contentLength)} bytes exceeds the ${String(MAX_ZIP_DOWNLOAD_BYTES)} byte limit`,
        { details: { url, bytes: contentLength } },
      );
    }
    if (resp.body === null) {
      return Buffer.from(await resp.arrayBuffer());
    }
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_ZIP_DOWNLOAD_BYTES) {
          throw new Error2(
            ErrorCodes.PLUGIN_LOAD_FAILED,
            `Zip download too large: exceeded the ${String(MAX_ZIP_DOWNLOAD_BYTES)} byte limit`,
            { details: { url, bytes: total } },
          );
        }
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function extractZip(buffer: Buffer, destDir: string): Promise<string> {
  await mkdir(destDir, { recursive: true });
  const destDirResolved = path.resolve(destDir);
  let settled = false;
  let entryCount = 0;
  let totalBytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      yauzlFromBuffer(buffer, { lazyEntries: true }, (openErr, zipfile) => {
        if (openErr !== null || zipfile === undefined) {
          reject(
            new Error2(
              ErrorCodes.PLUGIN_LOAD_FAILED,
              `Failed to open zip: ${openErr?.message ?? 'unknown error'}`,
              { cause: openErr ?? undefined },
            ),
          );
          return;
        }

        const onEntry = (entry: Entry): void => {
          entryCount += 1;
          if (entryCount > MAX_ARCHIVE_ENTRIES) {
            if (!settled) {
              settled = true;
              reject(
                new Error2(
                  ErrorCodes.PLUGIN_LOAD_FAILED,
                  `Zip contains too many entries (limit ${String(MAX_ARCHIVE_ENTRIES)})`,
                  { details: { entries: entryCount } },
                ),
              );
            }
            zipfile.close();
            return;
          }

          const fileName = entry.fileName;
          const destPath = path.resolve(destDir, fileName);

          if (destPath !== destDirResolved && !destPath.startsWith(destDirResolved + path.sep)) {
            if (!settled) {
              settled = true;
              reject(
                new Error2(
                  ErrorCodes.PLUGIN_LOAD_FAILED,
                  `Path traversal detected in zip entry: ${fileName}`,
                  { details: { entry: fileName } },
                ),
              );
            }
            zipfile.close();
            return;
          }

          if (fileName.endsWith('/')) {
            mkdir(destPath, { recursive: true })
              .then(() => {
                zipfile.readEntry();
              })
              .catch((error) => {
                if (!settled) {
                  settled = true;
                  reject(error);
                }
                zipfile.close();
              });
            return;
          }

          zipfile.openReadStream(entry, (streamErr, stream) => {
            if (streamErr !== null || stream === undefined) {
              if (!settled) {
                settled = true;
                reject(
                  new Error2(
                    ErrorCodes.PLUGIN_LOAD_FAILED,
                    `Failed to read ${fileName} from archive: ${streamErr?.message ?? 'unknown error'}`,
                    { cause: streamErr ?? undefined, details: { entry: fileName } },
                  ),
                );
              }
              zipfile.close();
              return;
            }

            let entryBytes = 0;
            const limiter = new Transform({
              transform(chunk, _encoding, callback) {
                entryBytes += chunk.length;
                totalBytes += chunk.length;
                if (entryBytes > MAX_ENTRY_BYTES) {
                  callback(
                    new Error2(
                      ErrorCodes.PLUGIN_LOAD_FAILED,
                      `Zip entry "${fileName}" exceeds the ${String(MAX_ENTRY_BYTES)} byte single-file limit`,
                      { details: { entry: fileName, bytes: entryBytes } },
                    ),
                  );
                  return;
                }
                if (totalBytes > MAX_TOTAL_EXTRACTED_BYTES) {
                  callback(
                    new Error2(
                      ErrorCodes.PLUGIN_LOAD_FAILED,
                      `Zip extraction exceeds the ${String(MAX_TOTAL_EXTRACTED_BYTES)} byte total limit`,
                      { details: { bytes: totalBytes } },
                    ),
                  );
                  return;
                }
                callback(null, chunk);
              },
            });

            mkdir(path.dirname(destPath), { recursive: true })
              .then(() => pipeline(stream, limiter, createWriteStream(destPath)))
              .then(() => restoreFilePermissions(destPath, entry))
              .then(() => {
                zipfile.readEntry();
              })
              .catch((error) => {
                if (!settled) {
                  settled = true;
                  reject(error);
                }
                zipfile.close();
              });
          });
        };

        zipfile.on('entry', onEntry);
        zipfile.on('end', () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
        zipfile.on('error', (err: Error) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
        zipfile.readEntry();
      });
    });
  } catch (error) {
    await rm(destDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return detectPluginRoot(destDir);
}

async function restoreFilePermissions(destPath: string, entry: Entry): Promise<void> {
  const mode = entry.externalFileAttributes >>> 16;
  if (mode === 0) return;
  const permissions = mode & 0o777;
  if (permissions === 0) return;
  await chmod(destPath, permissions);
}

async function detectPluginRoot(dir: string): Promise<string> {
  if (await hasManifest(dir)) return dir;

  const entries = await readdir(dir, { withFileTypes: true });
  const childDirs = entries.filter((entry) => entry.isDirectory());
  const childDir = childDirs.length === 1 ? childDirs[0] : undefined;
  if (childDir !== undefined) {
    const child = path.join(dir, childDir.name);
    if (await hasManifest(child)) return child;
  }

  return dir;
}

async function hasManifest(dir: string): Promise<boolean> {
  const rootManifest = path.join(dir, 'kimi.plugin.json');
  const dirManifest = path.join(dir, '.kimi-plugin', 'plugin.json');
  return (await isFile(rootManifest)) || (await isFile(dirManifest));
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}
