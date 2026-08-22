import { createDecorator } from '#/_base/di/instantiation';

/**
 * Opaque model-facing handle for one spilled artifact. A local backend may
 * use a filesystem path; a remote or database backend may use a URI or key.
 * Consumers render it with `retrievalHint`, but do not parse it.
 */
export type SpillLocator = string & { readonly __spillLocator: unique symbol };

/** Brand a string as a {@link SpillLocator}. */
export function SpillLocator(locator: string): SpillLocator {
  return locator as SpillLocator;
}

/**
 * Save-time storage namespace for a spilled artifact. The session id lets a
 * backend group storage under the producing session, but the returned
 * {@link SpillLocator} is the model-facing handle.
 */
export interface SpillOwner {
  readonly sessionId: string;
}

/**
 * Tool and call that produced one spilled artifact — recorded by the backend
 * for a readable filename and inspection. Not interpreted for access control;
 * purely descriptive.
 */
export interface SpillSource {
  /** The tool whose result was spilled (e.g. `bash`). */
  readonly toolName: string;
  /** The model-issued tool call id the result belongs to. */
  readonly callId: string;
  /** A short human label for the artifact (e.g. `result`). */
  readonly label: string;
}

/** One request to persist text to a spill artifact. */
export interface SaveTextSpill {
  readonly owner: SpillOwner;
  readonly source: SpillSource;
  /**
   * A caller-suggested base name (e.g. `bash-output.txt`). The backend
   * sanitizes it to a single safe path segment before use — it is a hint,
   * never a path.
   */
  readonly suggestedName: string;
  /** The full text to persist (UTF-8). */
  readonly content: string;
}

/** A saved spill artifact: its locator, byte length, and backend-specific retrieval guidance. */
export interface SpillRef {
  readonly locator: SpillLocator;
  readonly bytes: number;
  readonly retrievalHint: string;
}

export interface ISpillService {
  readonly _serviceBrand: undefined;

  /**
   * Persist `input.content` verbatim to a session-scoped spill artifact.
   * @param input - the owner, caller-supplied source fields, suggested name, and full text to save.
   * @returns the saved artifact's {@link SpillRef}; rejects on a storage failure.
   */
  saveText(input: SaveTextSpill): Promise<SpillRef>;

  /**
   * Read back a spilled artifact's full text.
   * @param locator - a locator previously returned by {@link saveText}.
   * @returns the persisted text, or `null` when the artifact is absent.
   */
  readText(locator: SpillLocator): Promise<string | null>;
}

export const ISpillService = createDecorator<ISpillService>('spillService');
