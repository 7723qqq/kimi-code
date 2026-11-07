import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'pathe';

export type AuditKind =
  | 'write_blocked'
  | 'write_allowed'
  | 'write_noop'
  | 'write_updated'
  | 'recall_filtered'
  | 'recall_gated'
  | 'injection_filtered'
  | 'consolidate'
  | 'evict_atoms'
  | 'evict_notes'
  | 'pin'
  | 'forget'
  | 'supersede'
  | 'reconsolidate'
  | 'embeddings_blocked'
  | 'embeddings_failed'
  | 'replay'
  | 'rebuild'
  | 'code_proposed'
  | 'code_approved'
  | 'label';

export interface AuditEntry {
  readonly at: number;
  readonly kind: AuditKind;
  readonly detail: Readonly<Record<string, unknown>>;
}

export const AUDIT_MAX_ENTRIES = 1000;
export const AUDIT_ROTATE_AT = 2000;
const AUDIT_TAIL_BYTES = 262_144;

export function auditPath(storeDir: string, storeRoot: string): string {
  return join(storeDir, storeRoot, 'audit.jsonl');
}

export async function appendAudit(path: string, entry: AuditEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
  await rotateAudit(path);
}

async function rotateAudit(path: string): Promise<void> {
  const file = Bun.file(path);
  const size = file.size;
  if (size <= AUDIT_TAIL_BYTES * 2) return;
  const content = await file.text();
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length <= AUDIT_ROTATE_AT) return;
  const kept = lines.slice(lines.length - AUDIT_MAX_ENTRIES);
  await writeFile(path, `${kept.join('\n')}\n`, 'utf8');
}

export async function readAudit(path: string, limit: number): Promise<readonly AuditEntry[]> {
  const file = Bun.file(path);
  let content: string;
  try {
    const size = file.size;
    const start = Math.max(0, size - AUDIT_TAIL_BYTES);
    content = await file.slice(start).text();
    if (start > 0) {
      const firstBreak = content.indexOf('\n');
      content = firstBreak === -1 ? '' : content.slice(firstBreak + 1);
    }
  } catch {
    return [];
  }
  const entries: AuditEntry[] = [];
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      continue;
    }
  }
  return entries.toReversed().slice(0, limit);
}

export async function writeAudit(path: string, entries: readonly AuditEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}
