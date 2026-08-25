/**
 * TUI2 shared autocomplete types.
 *
 * Mirrors `pi-tui/autocomplete.ts` — self-contained types, no pi-tui import.
 *
 * Status: REAL (tui2). Self-contained types; no pi-tui import.
 */

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

type Awaitable<T> = T | Promise<T>;

export interface SlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  // Function to get argument completions for this command
  // Returns null if no argument completion is available
  getArgumentCompletions?(argumentPrefix: string): Awaitable<AutocompleteItem[] | null>;
}

export interface AutocompleteSuggestions {
  items: AutocompleteItem[];
  prefix: string; // What we're matching against (e.g., "/" or "src/")
}

export interface AutocompleteProvider {
  /** Characters that should naturally trigger this provider at token boundaries. */
  triggerCharacters?: string[];

  // Get autocomplete suggestions for current text/cursor position
  // Returns null if no suggestions available
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null>;

  // Apply the selected item
  // Returns the new text and cursor position
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
  };

  // Check if file completion should trigger for explicit Tab completion
  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}