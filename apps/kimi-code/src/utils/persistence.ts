/**
 * Small persistence helpers for CLI-owned data files.
 *
 * This module is intentionally for non-config files only. User-facing
 * configuration is owned by core/SDK; do not route `config.toml` through
 * these helpers.
 */

import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { z } from 'zod';

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}

function assertNonConfigWrite(filePath: string): void {
  if (basename(filePath) === 'config.toml') {
    throw new Error(
      'CLI persistence helpers must not write config.toml; use core/SDK config APIs.',
    );
  }
}

function tempPathFor(filePath: string): string {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  return join(dir, `.${base}.${nonce}.tmp`);
}

export async function readJsonFile<T>(
  filePath: string,
  schema: z.ZodType<T>,
  fallback: T,
): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (error) {
    if (isNotFound(error)) return fallback;
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  return schema.parse(parsed);
}

export async function writeJsonFile<T>(
  filePath: string,
  schema: z.ZodType<T>,
  value: T,
): Promise<void> {
  assertNonConfigWrite(filePath);
  const parsed = schema.parse(value);
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = tempPathFor(filePath);
  try {
    await writeFile(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

export async function readJsonlFile<T>(filePath: string, lineSchema: z.ZodType<T>): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const entries: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const result = lineSchema.safeParse(parsed);
      if (result.success) entries.push(result.data);
    } catch {
      // JSONL is append-only user data; tolerate bad rows and keep the rest.
    }
  }
  return entries;
}

export async function appendJsonlLine<T>(
  filePath: string,
  lineSchema: z.ZodType<T>,
  value: T,
): Promise<void> {
  assertNonConfigWrite(filePath);
  const parsed = lineSchema.parse(value);
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(parsed)}\n`, 'utf-8');
}

/**
 * Create a file with `content` only when it does not exist yet — a
 * create-if-absent primitive for lock / marker files that must never
 * overwrite a concurrently published newer state. Throws `EEXIST` when the
 * path is already taken (callers decide whether that is a race or a stale
 * residue).
 */
export async function createFileIfAbsent(filePath: string, content: string): Promise<void> {
  assertNonConfigWrite(filePath);
  await mkdir(dirname(filePath), { recursive: true });
  const file = await open(filePath, 'wx', 0o600);
  try {
    await file.writeFile(content, 'utf-8');
  } finally {
    await file.close();
  }
}
