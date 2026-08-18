/**
 * Reverse RPC view-layer types and registration.
 *
 * Mirrors `tui/reverse-rpc/index.ts`. Wires the approval / question
 * controllers to the modal coordinator via injected UI hooks. The
 * coordinator guarantees a single modal at a time; the controllers queue
 * requests until the current one resolves.
 *
 * Status: REAL (tui2). Self-contained; no v1 re-export.
 */

import type { ApprovalController } from './approval/controller';
import { ReverseRpcModalCoordinator } from './modal-coordinator';
import type { QuestionController } from './question/controller';
import type { ApprovalPanelData, QuestionPanelData } from './types';

export interface ReverseRPCUIHooks {
  readonly showApprovalPanel: (payload: ApprovalPanelData) => void;
  readonly hideApprovalPanel: () => void;
  readonly showQuestionDialog: (payload: QuestionPanelData) => void;
  readonly hideQuestionDialog: () => void;
}

export function registerReverseRPCHandlers(
  approvalController: ApprovalController,
  questionController: QuestionController,
  uiHooks: ReverseRPCUIHooks,
): Array<() => void> {
  const modalCoordinator = new ReverseRpcModalCoordinator(uiHooks);

  // Setup UI hooks for controllers
  approvalController.setUIHooks({
    showPanel: (payload) => {
      modalCoordinator.showApproval(payload);
    },
    hidePanel: () => {
      modalCoordinator.hide('approval');
    },
  });

  questionController.setUIHooks({
    showPanel: (payload) => {
      modalCoordinator.showQuestion(payload);
    },
    hidePanel: () => {
      modalCoordinator.hide('question');
    },
  });

  return [
    () => {
      modalCoordinator.clear();
    },
  ];
}
