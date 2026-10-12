// Shape guards for wire records whose payload the type system asserts but
// nothing validates at runtime: the engine declares these with
// `z.custom<…>()` (no validation) and the wire-reader parses raw JSON lines,
// so a hand-edited or imported wire can carry a record that does not match
// its declared type. Dereferencing such a payload during render unmounts the
// React root (the whole app goes blank), so every reader goes through a
// guard here instead of trusting the type.
//
// The server has the same problem (audit a37/F3/F4) and solves it with a
// family of local guards in `context-projector.ts`; these are deliberately
// NOT shared across packages (vis-web must not import vis-server internals).

/** The `result` payload of `permission.record_approval_result`, read
 *  defensively. Returns `undefined` when the record has no usable `result`
 *  (missing, `null`, or not an object) so callers can render a placeholder
 *  instead of dereferencing `undefined`. Fields keep their raw values when
 *  present but are not type-checked — the renderers stringify them anyway. */
export interface ApprovalResultView {
  decision?: string;
  feedback?: string;
  scope?: string;
  selectedLabel?: string;
}

export function readApprovalResult(r: unknown): ApprovalResultView | undefined {
  if (r === null || typeof r !== 'object') return undefined;
  const result = (r as { result?: unknown }).result;
  if (result === null || typeof result !== 'object') return undefined;
  const raw = result as Record<string, unknown>;
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;
  return {
    decision: str(raw['decision']),
    feedback: str(raw['feedback']),
    scope: str(raw['scope']),
    selectedLabel: str(raw['selectedLabel']),
  };
}

/** Placeholder rendered where a guarded field is missing entirely. */
export const MISSING_APPROVAL_RESULT = '<missing result>';
