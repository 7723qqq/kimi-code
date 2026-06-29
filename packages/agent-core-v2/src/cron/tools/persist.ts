/**
 * `cron` domain (L5) — per-id atomic-document persistence for cron tasks.
 *
 * Backs cron task records (`<homeDir>/cron/<id>.json`) through the `storage`
 * access-pattern store (`IAtomicDocumentStore`) under the `cron` scope, so
 * the domain never touches the filesystem. Pins the cron-id shape (8
 * lowercase hex chars — the same shape `SessionCronStore` generates, doubling
 * as the path-traversal guard) and a shape guard for `CronTask`. A `CronTask`
 * is already pure plain data, so the on-disk record is the in-memory record
 * verbatim (an absent `recurring` round-trips as `undefined`). `list()`
 * silently drops stray files, corrupt JSON, and records that fail the shape
 * guard — the cron stack would rather lose a malformed task than refuse to
 * boot. Not scope-bound; constructed via {@link createCronPersistStore}.
 */

import type { IAtomicDocumentStore } from '#/storage';

import type { CronPersistence } from '../cron';
import type { CronTask } from './types';

export const CRON_ID_REGEX: RegExp = /^[0-9a-f]{8}$/;

const CRON_SCOPE = 'cron';
const JSON_SUFFIX = '.json';

export function isValidCronTask(obj: unknown): obj is CronTask {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || !CRON_ID_REGEX.test(o['id'])) return false;
  if (typeof o['cron'] !== 'string') return false;
  if (typeof o['prompt'] !== 'string') return false;
  if (typeof o['createdAt'] !== 'number') return false;
  if (o['recurring'] !== undefined && typeof o['recurring'] !== 'boolean') return false;
  if (
    o['lastFiredAt'] !== undefined &&
    (typeof o['lastFiredAt'] !== 'number' || !Number.isFinite(o['lastFiredAt']))
  ) {
    return false;
  }
  return true;
}

function cronKey(id: string): string {
  if (!CRON_ID_REGEX.test(id)) {
    throw new Error(`Invalid cron job id: "${id}"`);
  }
  return `${id}${JSON_SUFFIX}`;
}

export function createCronPersistStore(store: IAtomicDocumentStore): CronPersistence {
  return {
    async write(id, task) {
      await store.set(CRON_SCOPE, cronKey(id), task);
    },
    async remove(id) {
      await store.delete(CRON_SCOPE, cronKey(id));
    },
    async list() {
      const keys = await store.list(CRON_SCOPE);
      const tasks: CronTask[] = [];
      for (const key of keys) {
        if (!key.endsWith(JSON_SUFFIX)) continue;
        const id = key.slice(0, -JSON_SUFFIX.length);
        if (!CRON_ID_REGEX.test(id)) continue;
        const value = await store.get<CronTask>(CRON_SCOPE, key);
        if (value === undefined || !isValidCronTask(value)) continue;
        tasks.push(value);
      }
      return tasks;
    },
  };
}
