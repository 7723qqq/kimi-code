export type CompactPhase = 'idle' | 'queued' | 'compacting';

export function resolveCompactPhase(
  compaction: { status?: string } | null | undefined,
  queued: readonly { kind?: string }[] | undefined,
): CompactPhase {
  if (compaction?.status === 'running') return 'compacting';
  if (queued?.some((item) => item.kind === 'compact')) return 'queued';
  return 'idle';
}
