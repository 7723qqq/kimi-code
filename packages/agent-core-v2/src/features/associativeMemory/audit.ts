import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'pathe';

export type AuditKind =
  | 'write_blocked'
  | 'write_allowed'
  | 'recall_filtered'
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

export function auditPath(storeDir: string, storeRoot: string): string {
  return join(storeDir, storeRoot, 'audit.jsonl');
}

export async function appendAudit(path: string, entry: AuditEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
}

export async function readAudit(path: string, limit: number): Promise<readonly AuditEntry[]> {
  let content: string;
  try {
    content = await Bun.file(path).text();
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
