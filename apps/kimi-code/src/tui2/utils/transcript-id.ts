/**
 * Transcript entry id allocation: monotonically increasing `entry-N` ids for
 * TUI transcript entries.
 *
 * Status: REAL (tui2). Self-contained; no v1 re-export.
 */

let transcriptIdCounter = 0;

export function nextTranscriptId(): string {
  transcriptIdCounter += 1;
  return `entry-${String(transcriptIdCounter)}`;
}
