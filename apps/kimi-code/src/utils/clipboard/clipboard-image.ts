/**
 * Read media from the system clipboard with graceful platform fallbacks.
 *
 * Every model provider accepts PNG/JPEG/GIF/WebP (the engine widens the set
 * per provider, e.g. BMP/HEIC/HEIF for Kimi), and the clipboard sources we
 * query already emit those baseline formats on supported platforms — so we
 * deliberately do not include a BMP→PNG converter.
 *
 * Lookup order:
 *   macOS file clipboard       -> osascript/AppKit file URLs
 *   macOS / Windows            -> native `@mariozechner/clipboard`
 *   Linux Wayland              -> wl-paste
 *   Linux X11                  -> xclip
 *   WSL (image not on Linux cb) -> PowerShell fallback via wslpath
 *
 * Returns `null` when no supported media is available, the format isn't
 * supported, or every fallback fails.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

import { t } from '#/i18n';
import { documentMimeFromPath, parseImageMeta } from '#/utils/image/image-mime';

import {
  DEFAULT_LIST_TIMEOUT_MS,
  SUPPORTED_IMAGE_MIME_TYPES,
  baseMimeType,
  isFileLikeNativeFormat,
  isSupportedImageMimeType,
  isWaylandSession,
  isWSL,
  parseTargetList,
  runCommand as runCommandBase,
  safeAvailableFormats,
  type RunCommand,
  type RunCommandOptions,
} from './clipboard-common';
import { clipboard, type ClipboardModule } from './clipboard-native';

export interface ClipboardImage {
  kind: 'image';
  bytes: Uint8Array;
  mimeType: string;
}

export interface ClipboardVideo {
  kind: 'video';
  mimeType: string;
  filename: string;
  sourcePath: string;
}

export interface ClipboardDocument {
  kind: 'document';
  mimeType: string;
  filename: string;
  sourcePath: string;
}

export type ClipboardMedia = ClipboardImage | ClipboardVideo | ClipboardDocument;

export class ClipboardMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClipboardMediaError';
  }
}

function formatClipboardError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

const VIDEO_MIME_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '.mp4': 'video/mp4',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.wmv': 'video/x-ms-wmv',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
});

const DEFAULT_READ_TIMEOUT_MS = 3000;
const DEFAULT_POWERSHELL_TIMEOUT_MS = 5000;

const MACOS_FILE_PATH_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('Foundation');

const out = [];
const pb = $.NSPasteboard.generalPasteboard;
if (String(pb) !== '[id nil]') {
  try {
    const options = $.NSMutableDictionary.dictionary;
    options.setObjectForKey($.NSNumber.numberWithBool(true), $.NSPasteboardURLReadingFileURLsOnlyKey);
    const urls = pb.readObjectsForClassesOptions([$.NSURL], options);
    const count = urls ? urls.count : 0;
    for (let i = 0; i < count; i++) {
      const value = urls.objectAtIndex(i).path;
      const path = value ? ObjC.unwrap(value) : '';
      if (path) out.push(path);
    }
  } catch (error) {}

  if (out.length === 0) {
    try {
      const files = ObjC.deepUnwrap(pb.propertyListForType('NSFilenamesPboardType'));
      if (Array.isArray(files)) {
        for (const path of files) {
          if (path) out.push(String(path));
        }
      } else if (files) {
        out.push(String(files));
      }
    } catch (error) {}
  }
}
out.join('\n');
`.trim();

function selectPreferredImageMimeType(candidates: string[]): string | null {
  const normalized = candidates
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((raw) => ({ raw, base: baseMimeType(raw) }));

  for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
    const match = normalized.find((t) => t.base === preferred);
    if (match !== undefined) return match.raw;
  }
  const anyImage = normalized.find((t) => t.base.startsWith('image/'));
  return anyImage?.raw ?? null;
}

function videoMimeFromPath(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  const suffix = path.slice(dot).toLowerCase();
  return VIDEO_MIME_BY_SUFFIX[suffix] ?? null;
}

function parseClipboardPaths(text: string): string[] {
  return splitClipboardPathLines(text)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      if (line.startsWith('file://')) {
        try {
          return Bun.fileURLToPath(line);
        } catch {
          return '';
        }
      }
      return line;
    })
    .filter((line) => line.length > 0 && isAbsolute(line));
}

function splitClipboardPathLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\r' || char === '\n' || text.codePointAt(i) === 0) {
      lines.push(text.slice(start, i));
      start = i + 1;
    }
  }
  lines.push(text.slice(start));
  return lines;
}

function readImagePath(path: string): ClipboardImage | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;

  const meta = parseImageMeta(bytes);
  if (meta === null) return null;
  return { kind: 'image', bytes: new Uint8Array(bytes), mimeType: meta.mime };
}

function readVideoPath(path: string): ClipboardVideo | null {
  const mimeType = videoMimeFromPath(path);
  if (mimeType === null) return null;
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_VIDEO_BYTES) {
    throw new ClipboardMediaError(
      t('tui.statusMessages.videoExceedsMaxSize', {
        size: (stat.size / 1024 / 1024).toFixed(1),
        max: String(MAX_VIDEO_BYTES / 1024 / 1024),
      }),
    );
  }
  return {
    kind: 'video',
    mimeType,
    filename: basename(path),
    sourcePath: path,
  };
}

function readDocumentPath(path: string): ClipboardDocument | null {
  const mimeType = documentMimeFromPath(path);
  if (mimeType === null) return null;
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return { kind: 'document', mimeType, filename: basename(path), sourcePath: path };
}

function readMediaPath(path: string): ClipboardMedia | null {
  // Video files are never opened as images.
  const video = readVideoPath(path);
  if (video !== null) return video;
  const document = readDocumentPath(path);
  if (document !== null) return document;
  return readImagePath(path);
}

function readMediaFromPaths(paths: readonly string[]): ClipboardMedia | null {
  for (const path of paths) {
    const media = readMediaPath(path);
    if (media !== null) return media;
  }
  return null;
}

function readMediaFromText(text: string): ClipboardMedia | null {
  return readMediaFromPaths(parseClipboardPaths(text));
}

function runCommand(
  command: string,
  args: string[],
  options?: RunCommandOptions,
): { stdout: Buffer; ok: boolean } {
  return runCommandBase(command, args, {
    timeoutMs: options?.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
    env: options?.env,
  });
}

function readClipboardFileMediaViaWlPaste(run: RunCommand): ClipboardMedia | null {
  const list = run('wl-paste', ['--list-types'], {
    timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
  });
  if (!list.ok) return null;

  const types = parseTargetList(list.stdout);
  const uriType = types.find((t) => baseMimeType(t) === 'text/uri-list');
  if (uriType === undefined) return null;

  const uris = run('wl-paste', ['--type', uriType, '--no-newline']);
  return uris.ok ? readMediaFromText(uris.stdout.toString('utf-8')) : null;
}

function readClipboardImageViaWlPaste(run: RunCommand): ClipboardImage | null {
  const list = run('wl-paste', ['--list-types'], {
    timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
  });
  if (!list.ok) return null;

  const selected = selectPreferredImageMimeType(parseTargetList(list.stdout));
  if (selected === null) return null;

  const data = run('wl-paste', ['--type', selected, '--no-newline']);
  if (!data.ok || data.stdout.length === 0) return null;
  return { kind: 'image', bytes: data.stdout, mimeType: baseMimeType(selected) };
}

function readClipboardFileMediaViaXclip(run: RunCommand): ClipboardMedia | null {
  const targets = run('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], {
    timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
  });
  if (!targets.ok) return null;

  const candidates = parseTargetList(targets.stdout);
  const uriType = candidates.find((t) => baseMimeType(t) === 'text/uri-list');
  if (uriType === undefined) return null;

  const uris = run('xclip', ['-selection', 'clipboard', '-t', uriType, '-o']);
  return uris.ok ? readMediaFromText(uris.stdout.toString('utf-8')) : null;
}

function readClipboardImageViaXclip(run: RunCommand): ClipboardImage | null {
  const targets = run('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], {
    timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
  });

  const candidates = targets.ok ? parseTargetList(targets.stdout) : [];
  const preferred = candidates.length > 0 ? selectPreferredImageMimeType(candidates) : null;
  const tryTypes =
    preferred !== null
      ? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES]
      : [...SUPPORTED_IMAGE_MIME_TYPES];

  for (const mime of tryTypes) {
    const data = run('xclip', ['-selection', 'clipboard', '-t', mime, '-o']);
    if (data.ok && data.stdout.length > 0) {
      return { kind: 'image', bytes: data.stdout, mimeType: baseMimeType(mime) };
    }
  }
  return null;
}

/**
 * Read the clipboard image through PowerShell's `Clipboard.GetImage()`.
 *
 * Used on WSL, where a Windows clipboard image does not bridge into the Linux
 * one, and on Windows itself when the native binding reports an image it then
 * fails to hand back (several screenshot tools put an in-memory DIB on the
 * clipboard that `@mariozechner/clipboard` cannot decode — it answers
 * `hasImage() == true` and then throws). The round-trip goes through a temp PNG
 * because binary stdout is unreliable across the WSL interop boundary.
 */
function readClipboardImageViaPowerShell(
  run: RunCommand,
  env: NodeJS.ProcessEnv,
  resolveWinPath: (tempPath: string) => string | null,
): ClipboardImage | null {
  const tmpFile = join(tmpdir(), `kimi-clip-${randomUUID()}.png`);
  try {
    const winPath = resolveWinPath(tmpFile);
    if (winPath === null) return null;

    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$path = $env:KIMI_CLIPBOARD_IMAGE_PATH',
      '$img = [System.Windows.Forms.Clipboard]::GetImage()',
      "if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
    ].join('; ');

    const result = run('powershell.exe', ['-NoProfile', '-Command', psScript], {
      timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
      env: { ...env, KIMI_CLIPBOARD_IMAGE_PATH: winPath },
    });
    if (!result.ok) return null;
    if (result.stdout.toString('utf-8').trim() !== 'ok') return null;

    const bytes = readFileSync(tmpFile);
    if (bytes.length === 0) return null;
    return { kind: 'image', bytes: new Uint8Array(bytes), mimeType: 'image/png' };
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

/** WSL: the temp dir is a Linux path, and PowerShell needs the Windows one. */
function wslWinPath(run: RunCommand, tempPath: string): string | null {
  const result = run('wslpath', ['-w', tempPath], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
  if (!result.ok) return null;
  const winPath = result.stdout.toString('utf-8').trim();
  return winPath.length > 0 ? winPath : null;
}

/**
 * Windows: read a file-drop clipboard (a file copied in Explorer, or an image
 * a browser handed over as a URL). The native binding's `getText()` fails on
 * `CF_HDROP`, so PowerShell is the only reader.
 */
function readClipboardFilePathsViaPowerShell(run: RunCommand): string[] {
  const psScript = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$paths = [System.Windows.Forms.Clipboard]::GetFileDropList()',
    'if ($paths) { $paths | ForEach-Object { Write-Output $_ } }',
  ].join('; ');
  const result = run('powershell.exe', ['-NoProfile', '-Command', psScript], {
    timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
  });
  if (!result.ok) return [];
  return parseClipboardPaths(result.stdout.toString('utf-8'));
}

function readClipboardFilePathsViaMacOs(run: RunCommand): string[] {
  const result = run('osascript', ['-l', 'JavaScript', '-e', MACOS_FILE_PATH_SCRIPT], {
    timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
  });
  if (!result.ok || result.stdout.length === 0) return [];
  return parseClipboardPaths(result.stdout.toString('utf-8'));
}

async function readClipboardFileMediaViaNativeText(
  clip: ClipboardModule | null,
): Promise<{ media: ClipboardMedia | null; lookedFileLike: boolean }> {
  if (clip === null) return { media: null, lookedFileLike: false };

  const formats = safeAvailableFormats(clip);
  const lookedFileLike = formats.some(isFileLikeNativeFormat);
  if (!lookedFileLike || clip.getText === undefined) {
    return { media: null, lookedFileLike };
  }

  try {
    return { media: readMediaFromText(await clip.getText()), lookedFileLike };
  } catch (error) {
    if (error instanceof ClipboardMediaError) throw error;
    return { media: null, lookedFileLike };
  }
}

type NativeImageRead =
  | { readonly kind: 'image'; readonly image: ClipboardImage }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly error: unknown };

async function readClipboardImageViaNative(
  clip: ClipboardModule | null = clipboard,
): Promise<NativeImageRead> {
  if (clip === null) return { kind: 'empty' };

  let hasImage = false;
  try {
    hasImage = clip.hasImage();
  } catch {
    return { kind: 'empty' };
  }
  if (!hasImage) return { kind: 'empty' };

  try {
    const data = await clip.getImageBinary();
    if (data.length === 0) return { kind: 'empty' };
    return {
      kind: 'image',
      image: { kind: 'image', bytes: Uint8Array.from(data), mimeType: 'image/png' },
    };
  } catch (error) {
    return { kind: 'error', error };
  }
}

export async function readClipboardMedia(options?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  clipboard?: ClipboardModule | null;
  runCommand?: RunCommand;
}): Promise<ClipboardMedia | null> {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const clip = options?.clipboard ?? clipboard;
  const run = options?.runCommand ?? runCommand;

  // Termux on Android has no desktop clipboard; skip early rather than
  // churn through every fallback.
  if (env['TERMUX_VERSION'] !== undefined) return null;

  let image: ClipboardImage | null = null;
  if (platform === 'linux') {
    const wayland = isWaylandSession(env);
    const wsl = isWSL(env);

    if (wayland || wsl) {
      const fileMedia =
        readClipboardFileMediaViaWlPaste(run) ?? readClipboardFileMediaViaXclip(run);
      if (fileMedia !== null) return fileMedia;
      image = readClipboardImageViaWlPaste(run) ?? readClipboardImageViaXclip(run);
    }
    if (image === null && wsl) {
      image = readClipboardImageViaPowerShell(run, env, (tmp) => wslWinPath(run, tmp));
    }
    if (image === null && !wayland) {
      const nativeFileMedia = await readClipboardFileMediaViaNativeText(clip);
      if (nativeFileMedia.media !== null) return nativeFileMedia.media;
      if (nativeFileMedia.lookedFileLike) return null;
      const nativeImage = await readClipboardImageViaNative(clip);
      image = nativeImage.kind === 'image' ? nativeImage.image : null;
    }
  } else {
    if (platform === 'darwin') {
      const fileMedia = readMediaFromPaths(readClipboardFilePathsViaMacOs(run));
      if (fileMedia !== null) return fileMedia;
    }

    const nativeFileMedia = await readClipboardFileMediaViaNativeText(clip);
    if (nativeFileMedia.media !== null) return nativeFileMedia.media;

    // Finder exposes file icons/thumbnails as image data. If the clipboard
    // looks file-like but we could not read a real file path, do not consume
    // that icon as an image attachment.
    if (platform === 'darwin' && nativeFileMedia.lookedFileLike) {
      return null;
    }

    const nativeImage = await readClipboardImageViaNative(clip);
    image = nativeImage.kind === 'image' ? nativeImage.image : null;

    // A file copied in Explorer (or an image a browser handed over as a URL)
    // arrives as a CF_HDROP clipboard, where the native `getText()` fails.
    // Read the file list through PowerShell and treat it like a pasted path.
    if (image === null && platform === 'win32' && nativeFileMedia.lookedFileLike) {
      const fileMedia = readMediaFromPaths(readClipboardFilePathsViaPowerShell(run));
      if (fileMedia !== null) return fileMedia;
    }

    // Windows: the native binding can report an image it then fails to hand
    // back. Several screenshot tools put an in-memory DIB on the clipboard,
    // which `@mariozechner/clipboard` cannot decode — `hasImage()` answers
    // true and `getImageBinary()` throws. PowerShell reads the same clipboard
    // through a different path, so it is the fallback here.
    if (image === null && platform === 'win32') {
      image = readClipboardImageViaPowerShell(run, env, (tmp) => tmp);
      if (image === null && nativeImage.kind === 'error') {
        throw new ClipboardMediaError(
          t('tui.statusMessages.clipboardImageReadFailed', {
            error: formatClipboardError(nativeImage.error),
          }),
        );
      }
    }
  }

  if (image === null) return null;
  if (!isSupportedImageMimeType(image.mimeType)) return null;
  return image;
}
