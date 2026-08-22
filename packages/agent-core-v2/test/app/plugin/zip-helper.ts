import { createReadStream, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';
import { deflateRaw } from 'node:zlib';

const pipe = promisify(pipeline);

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const END_CENTRAL_DIR_SIG = 0x06054b50;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = 20;
const DEFLATE_METHOD = 8;

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32LE(v: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(v, 0);
  return buf;
}

function uint16LE(v: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(v, 0);
  return buf;
}

function localFileHeader(
  name: string,
  compressedSize: number,
  uncompressedSize: number,
  crc: number,
): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  return Buffer.concat([
    uint32LE(LOCAL_FILE_HEADER_SIG),
    uint16LE(VERSION_NEEDED),
    uint16LE(0),
    uint16LE(DEFLATE_METHOD),
    uint16LE(0),
    uint16LE(0),
    uint32LE(crc),
    uint32LE(compressedSize),
    uint32LE(uncompressedSize),
    uint16LE(nameBuf.length),
    uint16LE(0),
    nameBuf,
  ]);
}

function centralDirEntry(
  name: string,
  compressedSize: number,
  uncompressedSize: number,
  crc: number,
  localOffset: number,
): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  return Buffer.concat([
    uint32LE(CENTRAL_DIR_SIG),
    uint16LE(VERSION_MADE_BY),
    uint16LE(VERSION_NEEDED),
    uint16LE(0),
    uint16LE(DEFLATE_METHOD),
    uint16LE(0),
    uint16LE(0),
    uint32LE(crc),
    uint32LE(compressedSize),
    uint32LE(uncompressedSize),
    uint16LE(nameBuf.length),
    uint16LE(0),
    uint16LE(0),
    uint16LE(0),
    uint16LE(0),
    uint32LE(0),
    uint32LE(localOffset),
    nameBuf,
  ]);
}

function endCentralDir(
  numEntries: number,
  centralDirSize: number,
  centralDirOffset: number,
): Buffer {
  return Buffer.concat([
    uint32LE(END_CENTRAL_DIR_SIG),
    uint16LE(0),
    uint16LE(0),
    uint16LE(numEntries),
    uint16LE(numEntries),
    uint32LE(centralDirSize),
    uint32LE(centralDirOffset),
    uint16LE(0),
  ]);
}

export async function createZipFromDir(sourceDir: string): Promise<Buffer> {
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const st = statSync(fullPath);
      if (st.isFile()) {
        files.push(fullPath);
      } else if (st.isDirectory()) {
        walk(fullPath);
      }
    }
  }
  walk(sourceDir);

  const localHeaders: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let localOffset = 0;

  for (const filePath of files.toSorted()) {
    const name = relative(sourceDir, filePath).split(sep).join('/');
    const data = await readFile(filePath);
    const crc = crc32(data);
    const compressed = await new Promise<Buffer>((resolve, reject) => {
      deflateRaw(data, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
    const lh = localFileHeader(name, compressed.length, data.length, crc);
    localHeaders.push(Buffer.concat([lh, compressed]));
    centralEntries.push(centralDirEntry(name, compressed.length, data.length, crc, localOffset));
    localOffset += lh.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralEntries);
  const eocd = endCentralDir(files.length, centralDir.length, localOffset);

  return Buffer.concat([...localHeaders, centralDir, eocd]);
}
