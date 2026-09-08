import {
  appendFile,
  lstat,
  open,
  readFile,
  readdir,
  mkdir,
  realpath as nodeRealpath,
  rm,
  stat as nodeStat,
  writeFile,
} from 'node:fs/promises';

import { Error2 } from '#/compat/core.js';



export type TextDecodeErrors = 'strict' | 'replace' | 'ignore';

export interface HostFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink?: boolean;
  readonly size: number;
  readonly mtimeMs?: number;
  readonly ino?: number;
}

export interface HostDirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink?: boolean;
}

export interface IHostFileSystem {
  readonly _serviceBrand: undefined;

  readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  appendText(path: string, data: string): Promise<void>;
  readBytes(path: string, n?: number, offset?: number): Promise<Uint8Array>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): AsyncGenerator<string>;
  createExclusive(path: string, data: Uint8Array): Promise<boolean>;
  stat(path: string): Promise<HostFileStat>;
  lstat(path: string): Promise<HostFileStat>;
  readdir(path: string): Promise<readonly HostDirEntry[]>;
  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  remove(path: string): Promise<void>;
  realpath(path: string): Promise<string>;
}





function isUtf8Continuation(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
}

function decodeUtf8Ignore(data: Buffer): string {
  let output = '';
  let i = 0;

  while (i < data.length) {
    const b0 = data[i];
    if (b0 === undefined) break;

    if (b0 <= 0x7f) {
      output += String.fromCodePoint(b0);
      i += 1;
      continue;
    }

    if (b0 >= 0xc2 && b0 <= 0xdf) {
      const b1 = data[i + 1];
      if (b1 !== undefined && isUtf8Continuation(b1)) {
        output += String.fromCodePoint(((b0 & 0x1f) << 6) | (b1 & 0x3f));
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (b0 >= 0xe0 && b0 <= 0xef) {
      const b1 = data[i + 1];
      const b2 = data[i + 2];
      const validSecond =
        b1 !== undefined &&
        ((b0 === 0xe0 && b1 >= 0xa0 && b1 <= 0xbf) ||
          (b0 >= 0xe1 && b0 <= 0xec && isUtf8Continuation(b1)) ||
          (b0 === 0xed && b1 >= 0x80 && b1 <= 0x9f) ||
          (b0 >= 0xee && b0 <= 0xef && isUtf8Continuation(b1)));

      if (validSecond && b2 !== undefined && isUtf8Continuation(b2)) {
        output += String.fromCodePoint(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }

    if (b0 >= 0xf0 && b0 <= 0xf4) {
      const b1 = data[i + 1];
      const b2 = data[i + 2];
      const b3 = data[i + 3];
      const validSecond =
        b1 !== undefined &&
        ((b0 === 0xf0 && b1 >= 0x90 && b1 <= 0xbf) ||
          (b0 >= 0xf1 && b0 <= 0xf3 && isUtf8Continuation(b1)) ||
          (b0 === 0xf4 && b1 >= 0x80 && b1 <= 0x8f));

      if (
        validSecond &&
        b2 !== undefined &&
        b3 !== undefined &&
        isUtf8Continuation(b2) &&
        isUtf8Continuation(b3)
      ) {
        output += String.fromCodePoint(
          ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f),
        );
        i += 4;
        continue;
      }
      i += 1;
      continue;
    }

    i += 1;
  }

  return output;
}

function decodeUtf16LeIgnore(data: Buffer): string {
  let output = '';
  let i = 0;

  while (i + 1 < data.length) {
    const first = data[i];
    const second = data[i + 1];
    if (first === undefined || second === undefined) break;

    const codeUnit = first | (second << 8);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const lowFirst = data[i + 2];
      const lowSecond = data[i + 3];
      if (lowFirst !== undefined && lowSecond !== undefined) {
        const low = lowFirst | (lowSecond << 8);
        if (low >= 0xdc00 && low <= 0xdfff) {
          const codePoint = 0x10000 + ((codeUnit - 0xd800) << 10) + (low - 0xdc00);
          output += String.fromCodePoint(codePoint);
          i += 4;
          continue;
        }
      }
      i += 2;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      i += 2;
      continue;
    }

    output += String.fromCodePoint(codeUnit);
    i += 2;
  }

  return output;
}

export function decodeTextWithErrors(
  data: Buffer,
  encoding: BufferEncoding,
  errors: TextDecodeErrors = 'strict',
  ignoreBOM: boolean = false,
): string {
  let webLabel: string | undefined;
  switch (encoding) {
    case 'utf-8':
    case 'utf8':
      webLabel = 'utf-8';
      break;
    case 'utf16le':
    case 'ucs2':
    case 'ucs-2':
      webLabel = 'utf-16le';
      break;
    default:
      webLabel = undefined;
  }

  if (webLabel === undefined) {
    return data.toString(encoding);
  }

  if (errors === 'strict') {
    return new TextDecoder(webLabel, { fatal: true, ignoreBOM }).decode(data);
  }

  if (errors === 'ignore') {
    return webLabel === 'utf-8' ? decodeUtf8Ignore(data) : decodeUtf16LeIgnore(data);
  }

  return new TextDecoder(webLabel, { fatal: false, ignoreBOM }).decode(data);
}





const OsFsCodes = {
  OS_FS_NOT_FOUND: 'os.fs.not_found',
  OS_FS_IS_DIRECTORY: 'os.fs.is_directory',
  OS_FS_ALREADY_EXISTS: 'os.fs.already_exists',
  OS_FS_NOT_EMPTY: 'os.fs.not_empty',
  OS_FS_PERMISSION_DENIED: 'os.fs.permission_denied',
  OS_FS_UNKNOWN: 'os.fs.unknown',
} as const;

type HostFsErrorCode = (typeof OsFsCodes)[keyof typeof OsFsCodes];

export class HostFsError extends Error2 {
  constructor(code: HostFsErrorCode, message: string) {
    super(code, message);
    this.name = 'HostFsError';
  }
}

const REASONS: Record<HostFsErrorCode, string> = {
  'os.fs.not_found': 'path does not exist',
  'os.fs.is_directory': 'path is a directory',
  'os.fs.already_exists': 'path already exists',
  'os.fs.not_empty': 'directory is not empty',
  'os.fs.permission_denied': 'permission denied',
  'os.fs.unknown': 'unrecognized filesystem error',
};

function readErrno(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function mapErrno(errno: string | undefined): HostFsErrorCode {
  if (errno === undefined) return OsFsCodes.OS_FS_UNKNOWN;
  switch (errno) {
    case 'ENOENT':
      return OsFsCodes.OS_FS_NOT_FOUND;
    case 'EISDIR':
      return OsFsCodes.OS_FS_IS_DIRECTORY;
    case 'EEXIST':
      return OsFsCodes.OS_FS_ALREADY_EXISTS;
    case 'ENOTEMPTY':
      return OsFsCodes.OS_FS_NOT_EMPTY;
    case 'EACCES':
    case 'EPERM':
      return OsFsCodes.OS_FS_PERMISSION_DENIED;
    default:
      return OsFsCodes.OS_FS_UNKNOWN;
  }
}

export function toHostFsError(error: unknown, ctx: { path: string; op: string }): HostFsError {
  if (error instanceof HostFsError) return error;
  const errno = readErrno(error);
  const code = mapErrno(errno);
  return new HostFsError(code, `${ctx.op} failed: ${REASONS[code]}`);
}





const READ_CHUNK_SIZE = 64 * 1024;

function isUtf8Encoding(encoding: BufferEncoding): boolean {
  return encoding === 'utf-8' || encoding === 'utf8';
}

function* splitLinesKeepingTerminator(text: string): Generator<string> {
  if (text.length === 0) return;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.codePointAt(i) === 0x0a) {
      yield text.slice(start, i + 1);
      start = i + 1;
    }
  }
  if (start < text.length) {
    yield text.slice(start);
  }
}

export class HostFileSystem implements IHostFileSystem {
  declare readonly _serviceBrand: undefined;

  async readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): Promise<string> {
    try {
      if (options === undefined) {
        return await readFile(path, 'utf8');
      }
      const encoding = options.encoding ?? 'utf-8';
      const errors = options.errors ?? 'strict';
      return decodeTextWithErrors(await readFile(path), encoding, errors);
    } catch (error) {
      throw toHostFsError(error, { path, op: 'read' });
    }
  }

  async writeText(path: string, data: string): Promise<void> {
    try {
      await writeFile(path, data, 'utf8');
    } catch (error) {
      throw toHostFsError(error, { path, op: 'write' });
    }
  }

  async appendText(path: string, data: string): Promise<void> {
    try {
      await appendFile(path, data, 'utf8');
    } catch (error) {
      throw toHostFsError(error, { path, op: 'append' });
    }
  }

  async readBytes(path: string, n?: number, offset = 0): Promise<Uint8Array> {
    try {
      if (n === undefined && offset === 0) {
        const buf = await readFile(path);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      }
      const fh = await open(path, 'r');
      try {
        const length = n ?? Math.max(0, (await fh.stat()).size - offset);
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch (error) {
      throw toHostFsError(error, { path, op: 'read' });
    }
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    try {
      await writeFile(path, data);
    } catch (error) {
      throw toHostFsError(error, { path, op: 'write' });
    }
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): AsyncGenerator<string> {
    try {
      const encoding = options?.encoding ?? 'utf-8';
      const errors = options?.errors ?? 'strict';

      if (!isUtf8Encoding(encoding)) {
        const content = decodeTextWithErrors(await readFile(path), encoding, errors);
        yield* splitLinesKeepingTerminator(content);
        return;
      }

      yield* this._readUtf8Lines(path, errors);
    } catch (error) {
      throw toHostFsError(error, { path, op: 'read' });
    }
  }

  private async *_readUtf8Lines(
    path: string,
    errors: TextDecodeErrors,
  ): AsyncGenerator<string> {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(READ_CHUNK_SIZE);
      let pending: Buffer[] = [];
      let pendingOffset = 0;
      let fileOffset = 0;

      while (true) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        const chunk = buf.subarray(0, bytesRead);
        let lineStart = 0;

        for (let i = 0; i < chunk.length; i += 1) {
          const byte = chunk[i];
          if (byte !== 0x0a) continue;
          const piece = chunk.subarray(lineStart, i + 1);
          const lineOffset = pending.length === 0 ? fileOffset + lineStart : pendingOffset;
          const line =
            pending.length === 0 ? piece : Buffer.concat([...pending, piece]);
          yield decodeTextWithErrors(line, 'utf-8', errors, lineOffset !== 0);
          pending = [];
          lineStart = i + 1;
        }

        if (lineStart < chunk.length) {
          const tail = Buffer.from(chunk.subarray(lineStart));
          if (pending.length === 0) pendingOffset = fileOffset + lineStart;
          pending.push(tail);
        }
        fileOffset += bytesRead;
      }

      if (pending.length > 0) {
        const line = Buffer.concat(pending);
        yield decodeTextWithErrors(line, 'utf-8', errors, pendingOffset !== 0);
      }
    } finally {
      await fh.close();
    }
  }

  async createExclusive(path: string, data: Uint8Array): Promise<boolean> {
    try {
      const fh = await open(path, 'wx');
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw toHostFsError(error, { path, op: 'create' });
    }
  }

  async stat(path: string): Promise<HostFileStat> {
    try {
      const s = await nodeStat(path);
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
        size: s.size,
        mtimeMs: s.mtimeMs,
        ino: s.ino,
      };
    } catch (error) {
      throw toHostFsError(error, { path, op: 'stat' });
    }
  }

  async lstat(path: string): Promise<HostFileStat> {
    try {
      const s = await lstat(path);
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
        size: s.size,
        mtimeMs: s.mtimeMs,
        ino: s.ino,
      };
    } catch (error) {
      throw toHostFsError(error, { path, op: 'lstat' });
    }
  }

  async readdir(path: string): Promise<readonly HostDirEntry[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((d) => ({
        name: d.name,
        isFile: d.isFile(),
        isDirectory: d.isDirectory(),
        isSymbolicLink: d.isSymbolicLink(),
      }));
    } catch (error) {
      throw toHostFsError(error, { path, op: 'readdir' });
    }
  }

  async mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    try {
      await mkdir(path, { recursive: options?.recursive ?? false });
    } catch (error) {
      throw toHostFsError(error, { path, op: 'mkdir' });
    }
  }

  async remove(path: string): Promise<void> {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      throw toHostFsError(error, { path, op: 'remove' });
    }
  }

  async realpath(path: string): Promise<string> {
    try {
      return await nodeRealpath(path);
    } catch (error) {
      throw toHostFsError(error, { path, op: 'realpath' });
    }
  }
}