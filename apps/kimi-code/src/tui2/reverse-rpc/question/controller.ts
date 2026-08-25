/**
 * Question reverse RPC controller.
 *
 * Mirrors `tui/reverse-rpc/question/controller.ts`. Queues question dialog
 * requests and produces an empty-answers cancellation response. Pure logic.
 *
 * Status: REAL (tui2). Self-contained; no v1 re-export.
 */

import { ReverseRpcController } from '../base-controller';
import type { QuestionPanelData, QuestionPanelResponse } from '../types';

export class QuestionController extends ReverseRpcController<
  QuestionPanelData,
  QuestionPanelResponse
> {
  protected createCancelResponse(_reason: string): QuestionPanelResponse {
    return { answers: [] };
  }
}
