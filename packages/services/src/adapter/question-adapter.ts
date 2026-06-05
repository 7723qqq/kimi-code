/**
 * Question adapter (W8.2 / Chain 6).
 *
 * Bridges two representations of the same question interaction:
 *
 *   1. **In-process SDK shape** (agent-core, camelCase) — what
 *      `BridgeClientAPI` sees from `KimiCore.requestQuestion(...)`. See
 *      `packages/agent-core/src/rpc/sdk-api.ts:50-54`:
 *        `QuestionRequest { turnId?, toolCallId?, questions: QuestionItem[] }`
 *      where `QuestionItem` has `question, header?, body?, options[],
 *      multiSelect?, otherLabel?, otherDescription?`.
 *      `QuestionResult = null | QuestionAnswers | QuestionResponse`,
 *      `QuestionAnswers = Record<string, string | true>`.
 *
 *   2. **Protocol wire shape** (snake_case, with daemon-allocated metadata) —
 *      defined in `packages/protocol/src/question.ts`. 5-kind discriminated
 *      union for answers: `single | multi | other | multi_with_other | skipped`.
 *
 * **Field translations (request)**:
 *
 *     SDK (camelCase)        → Protocol (snake_case)
 *     ------------------------------------------------
 *     turnId                 → turn_id
 *     toolCallId             → tool_call_id
 *     questions[].question   → questions[].question (unchanged)
 *     questions[].multiSelect → questions[].multi_select
 *     questions[].otherLabel  → questions[].other_label
 *     questions[].otherDescription → questions[].other_description
 *     questions[].options[].label → questions[].options[].label (unchanged)
 *
 * **Synthesizing stable ids** (W8.2 — SDK has no per-item / per-option `id`):
 *   - `QuestionItem.id`     ← `q_<index>` (e.g. `q_0`, `q_1`, ...)
 *   - `QuestionOption.id`   ← `opt_<parent_idx>_<option_idx>` (e.g. `opt_0_0`)
 *     The ids are deterministic, lexicographically stable, and the adapter
 *     uses them as the round-trip key when projecting answers BACK to the
 *     SDK `Record<string, string | true>` shape.
 *
 * **Field translations (response, SCHEMAS §6.4 verbatim)**:
 *
 *     Protocol QuestionAnswer (kind)   → in-process Record<qid, string|true>
 *     ----------------------------------------------------------------------
 *     'single'           → answers[qid] = option_id
 *     'multi'            → answers[qid] = option_ids.join(',')     (lossy)
 *     'other'            → answers[qid] = text
 *     'multi_with_other' → answers[qid] = [...option_ids, other_text].join(',')
 *     'skipped'          → answers entry OMITTED entirely
 *
 * The lossy `multi` flattening matches SCHEMAS §6.4 verbatim. agent-core's
 * downstream consumer (`packages/agent-core/src/agent/tools/ask-user.ts`)
 * splits the comma-joined value back when needed.
 *
 * **Anti-corruption**: this is the ONLY place protocol↔SDK shape translation
 * happens for question. Daemon REST routes call `toBrokerRequest` indirectly
 * via the bridge and `toAgentCoreResponse` from the REST resolve handler.
 */

import type {
  QuestionAnswers as InProcessQuestionAnswers,
  QuestionItem as InProcessQuestionItem,
  QuestionRequest as InProcessQuestionRequest,
  QuestionResponse as InProcessQuestionResponse,
} from '@moonshot-ai/agent-core';
import type {
  QuestionItem as ProtocolQuestionItem,
  QuestionOption as ProtocolQuestionOption,
  QuestionRequest as ProtocolQuestionRequest,
  QuestionResponse as ProtocolQuestionResponse,
} from '@moonshot-ai/protocol';

export interface QuestionToBrokerRequestParams {
  /** Daemon-minted ULID identifying this question interaction. */
  readonly questionId: string;
  /** Session the question lives in. */
  readonly sessionId: string;
  /** `createdAt` ISO string; broker passes `new Date().toISOString()`. */
  readonly createdAt: string;
  /** `expiresAt` ISO string; broker computes `createdAt + 60s`. */
  readonly expiresAt: string;
}

/**
 * Build a protocol option from an SDK option. SDK has only `label?:string` +
 * `description?:string`; we synthesize `id` from parent and child indices so
 * `toAgentCoreAnswers` can map back through `Record<qid, string>`.
 */
function buildOption(
  opt: { readonly label: string; readonly description?: string },
  parentIdx: number,
  optIdx: number,
): ProtocolQuestionOption {
  const base: ProtocolQuestionOption = {
    id: `opt_${parentIdx}_${optIdx}`,
    label: opt.label,
  };
  return opt.description === undefined ? base : { ...base, description: opt.description };
}

/**
 * Build a protocol question item from an SDK item + its position. The
 * synthesized `id` (`q_<parentIdx>`) is the key the SDK answers Record uses.
 */
function buildItem(
  item: InProcessQuestionItem,
  parentIdx: number,
): ProtocolQuestionItem {
  const id = `q_${parentIdx}`;
  const out: ProtocolQuestionItem = {
    id,
    question: item.question,
    options: item.options.map((o, oi) => buildOption(o, parentIdx, oi)),
  };
  if (item.header !== undefined) out.header = item.header;
  if (item.body !== undefined) out.body = item.body;
  if (item.multiSelect !== undefined) out.multi_select = item.multiSelect;
  // SDK has no `allowOther` field — `otherLabel` / `otherDescription` exist
  // and we expose them on the wire alongside an inferred `allow_other: true`
  // when either tag is set. (SDK semantics: presence of `otherLabel` enables
  // the "Other" affordance; we surface that explicitly on the wire so client
  // renderers don't have to infer.)
  const hasOtherAffordance =
    item.otherLabel !== undefined || item.otherDescription !== undefined;
  if (hasOtherAffordance) out.allow_other = true;
  if (item.otherLabel !== undefined) out.other_label = item.otherLabel;
  if (item.otherDescription !== undefined) out.other_description = item.otherDescription;
  return out;
}

/**
 * In-process SDK request + daemon-allocated metadata → protocol wire shape.
 */
export function toBrokerRequest(
  req: InProcessQuestionRequest,
  params: QuestionToBrokerRequestParams,
): ProtocolQuestionRequest {
  const out: ProtocolQuestionRequest = {
    question_id: params.questionId,
    session_id: params.sessionId,
    questions: req.questions.map((q, i) => buildItem(q, i)),
    created_at: params.createdAt,
    expires_at: params.expiresAt,
  };
  if (req.turnId !== undefined) out.turn_id = req.turnId;
  if (req.toolCallId !== undefined) out.tool_call_id = req.toolCallId;
  return out;
}

/**
 * Protocol REST response body → in-process SDK `QuestionResponse` (with
 * `answers` flattened to `Record<string, string | true>`).
 *
 * Normalization rules from SCHEMAS §6.4:
 *   - single            → option_id
 *   - multi             → option_ids.join(',')
 *   - other             → text
 *   - multi_with_other  → [...option_ids, other_text].join(',')
 *   - skipped           → OMIT entry
 */
export function toAgentCoreResponse(
  resp: ProtocolQuestionResponse,
): InProcessQuestionResponse {
  const flattened: InProcessQuestionAnswers = {};
  for (const [qid, ans] of Object.entries(resp.answers)) {
    switch (ans.kind) {
      case 'single':
        flattened[qid] = ans.option_id;
        break;
      case 'multi':
        flattened[qid] = ans.option_ids.join(',');
        break;
      case 'other':
        flattened[qid] = ans.text;
        break;
      case 'multi_with_other':
        flattened[qid] = [...ans.option_ids, ans.other_text].join(',');
        break;
      case 'skipped':
        // Omitted from the record — matches SCHEMAS §6.4 ("if skipped continue").
        break;
      default: {
        // Defensive: never-reached if Zod schema is the SOT, but TS narrowing
        // is exhaustive so this is unreachable.
        const _exhaustive: never = ans;
        void _exhaustive;
      }
    }
  }
  const out: InProcessQuestionResponse = { answers: flattened };
  if (resp.method !== undefined) {
    // SCHEMAS §6.2 protocol allows 'click' as a method; agent-core's in-process
    // `QuestionAnswerMethod` is `'enter' | 'space' | 'number_key'` (NO 'click').
    // Drop 'click' on the in-process side to preserve type safety; the wire
    // form keeps it for clients that want to surface the affordance used.
    if (resp.method !== 'click') {
      (out as { method?: typeof resp.method }).method = resp.method;
    }
  }
  return out;
}

/**
 * Convenience: SDK semantics for "dismiss the entire question group" is the
 * `null` QuestionResult. Exposed as a helper so daemon code reads
 * intentionally rather than litter `null` constants.
 */
export function dismissedResult(): null {
  return null;
}
