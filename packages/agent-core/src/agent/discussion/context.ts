/**
 * DiscussionContext — shared discussion transcript for multi-agent roundtables.
 *
 * This is a pure data class that stores the ordered list of discussion entries
 * (speaker, agentId, content, round) and can render the full transcript as a
 * text block to be injected into each participant agent's context.
 *
 * There is no dependency on Agent, TurnFlow, or any other core module — it is
 * a standalone value object.
 */

export interface DiscussionEntry {
  readonly speaker: string;
  readonly agentId: string;
  readonly content: string;
  readonly round: number;
}

export class DiscussionContext {
  private readonly entries: DiscussionEntry[] = [];

  addEntry(
    speaker: string,
    agentId: string,
    content: string,
    round: number,
  ): void {
    this.entries.push({ speaker, agentId, content, round });
  }

  /** The current round number (1-based). 0 before any entry. */
  getRound(): number {
    if (this.entries.length === 0) return 0;
    return this.entries[this.entries.length - 1]!.round;
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  lastSpeaker(): string | null {
    if (this.entries.length === 0) return null;
    return this.entries[this.entries.length - 1]!.speaker;
  }

  latestEntry(): DiscussionEntry | null {
    if (this.entries.length === 0) return null;
    return this.entries[this.entries.length - 1]!;
  }

  allEntries(): readonly DiscussionEntry[] {
    return [...this.entries];
  }

  /** Total number of entries (speeches) recorded. */
  entryCount(): number {
    return this.entries.length;
  }

  /**
   * Render the entire discussion transcript as a text block suitable for
   * injection into a participant agent's context.
   */
  getTranscript(): string {
    if (this.entries.length === 0) return '';

    return this.entries
      .map((entry) => `[${entry.speaker}] ${entry.content}`)
      .join('\n\n');
  }
}