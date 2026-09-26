interface InsertMentionParams {
  text: string;
  cursorPos: number;
  filePath: string;
  activeToken: { start: number } | null;
  isAppend: boolean;
}

interface InsertMentionResult {
  newText: string;
  newCursorPos: number;
}

export function computeMentionInsert(params: InsertMentionParams): InsertMentionResult {
  const { text, cursorPos, filePath, activeToken, isAppend } = params;
  // Quote paths containing spaces, as the CLI/TUI mention completers do, so
  // whitespace cannot split the mention.
  const target = filePath.includes(" ") ? `"${filePath}"` : filePath;

  if (isAppend || !activeToken) {
    const newText = text + `@${target} `;
    return { newText, newCursorPos: newText.length };
  }

  const before = text.slice(0, activeToken.start);
  const after = text.slice(cursorPos);
  const newText = `${before}@${target} ${after}`;
  const newCursorPos = activeToken.start + 1 + target.length + 1;

  return { newText, newCursorPos };
}

/**
 * Fold a freshly mirrored editor selection into the draft.
 *
 * A selection drag re-sends the same mention on every change, so this replaces
 * rather than appends — otherwise the draft fills with one mention per line
 * crossed. `lastSynced` is what the composer last received; a draft that no
 * longer contains it has been edited by the user, and a sync arriving then is a
 * stale echo that must not overwrite their text.
 *
 * The first sync has nothing to replace and is treated as the draft gaining its
 * first mention.
 */
export function applySelectionSync(
  text: string,
  lastSynced: string | null,
  mention: string,
): { newText: string; lastSynced: string | null } {
  if (lastSynced === null) {
    return { newText: `${text}${mention} `, lastSynced: mention };
  }
  if (!text.includes(lastSynced)) {
    return { newText: text, lastSynced };
  }
  return { newText: text.replace(lastSynced, mention), lastSynced: mention };
}
