import { describe, expect, it, mock } from 'bun:test';

import { ApprovalController } from '#/tui/reverse-rpc/approval/controller';
import { registerReverseRPCHandlers } from '#/tui/reverse-rpc/index';
import { QuestionController } from '#/tui/reverse-rpc/question/controller';

describe('registerReverseRPCHandlers', () => {
  it('wires controller UI hooks without registering wire request handlers', async () => {
    const approvalController = new ApprovalController();
    const questionController = new QuestionController();
    const uiHooks = {
      showApprovalPanel: mock(),
      hideApprovalPanel: mock(),
      showQuestionDialog: mock(),
      hideQuestionDialog: mock(),
    };

    registerReverseRPCHandlers(approvalController, questionController, uiHooks);

    const approvalPending = approvalController.show({
      id: 'req-1',
      tool_call_id: 'tc-1',
      tool_name: 'Bash',
      action: 'run',
      description: '',
      display: [],
      choices: [],
    });
    expect(uiHooks.showApprovalPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'req-1' }),
    );
    approvalController.cancelAll('bye');
    await expect(approvalPending).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'bye',
    });
    expect(uiHooks.hideApprovalPanel).toHaveBeenCalledTimes(1);

    const questionPending = questionController.show({
      id: 'q-1',
      tool_call_id: 'tc-1',
      questions: [],
    });
    expect(uiHooks.showQuestionDialog).toHaveBeenCalledWith(expect.objectContaining({ id: 'q-1' }));
    questionController.cancelAll('bye');
    await expect(questionPending).resolves.toEqual({ answers: [] });
    expect(uiHooks.hideQuestionDialog).toHaveBeenCalledTimes(1);
  });

  it('queues question dialogs behind active approval panels', async () => {
    const approvalController = new ApprovalController();
    const questionController = new QuestionController();
    const uiHooks = {
      showApprovalPanel: mock(),
      hideApprovalPanel: mock(),
      showQuestionDialog: mock(),
      hideQuestionDialog: mock(),
    };

    registerReverseRPCHandlers(approvalController, questionController, uiHooks);

    const approvalPending = approvalController.show({
      id: 'approval-1',
      tool_call_id: 'tc-1',
      tool_name: 'Bash',
      action: 'run',
      description: '',
      display: [],
      choices: [],
    });
    const questionPending = questionController.show({
      id: 'question-1',
      tool_call_id: 'tq-1',
      questions: [],
    });

    expect(uiHooks.showApprovalPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'approval-1' }),
    );
    expect(uiHooks.showQuestionDialog).not.toHaveBeenCalled();

    approvalController.respond({ decision: 'approved' });
    await expect(approvalPending).resolves.toEqual({ decision: 'approved' });
    expect(uiHooks.hideApprovalPanel).toHaveBeenCalledTimes(1);
    expect(uiHooks.showQuestionDialog).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'question-1' }),
    );

    questionController.respond({ answers: ['answer'] });
    await expect(questionPending).resolves.toEqual({ answers: ['answer'] });
    expect(uiHooks.hideQuestionDialog).toHaveBeenCalledTimes(1);
  });

  it('queues approval panels behind active question dialogs', async () => {
    const approvalController = new ApprovalController();
    const questionController = new QuestionController();
    const uiHooks = {
      showApprovalPanel: mock(),
      hideApprovalPanel: mock(),
      showQuestionDialog: mock(),
      hideQuestionDialog: mock(),
    };

    registerReverseRPCHandlers(approvalController, questionController, uiHooks);

    const questionPending = questionController.show({
      id: 'question-1',
      tool_call_id: 'tq-1',
      questions: [],
    });
    const approvalPending = approvalController.show({
      id: 'approval-1',
      tool_call_id: 'tc-1',
      tool_name: 'Bash',
      action: 'run',
      description: '',
      display: [],
      choices: [],
    });

    expect(uiHooks.showQuestionDialog).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'question-1' }),
    );
    expect(uiHooks.showApprovalPanel).not.toHaveBeenCalled();

    questionController.respond({ answers: ['answer'] });
    await expect(questionPending).resolves.toEqual({ answers: ['answer'] });
    expect(uiHooks.hideQuestionDialog).toHaveBeenCalledTimes(1);
    expect(uiHooks.showApprovalPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'approval-1' }),
    );

    approvalController.respond({ decision: 'approved' });
    await expect(approvalPending).resolves.toEqual({ decision: 'approved' });
    expect(uiHooks.hideApprovalPanel).toHaveBeenCalledTimes(1);
  });

  it('removes queued modals when their controller is cancelled', async () => {
    const approvalController = new ApprovalController();
    const questionController = new QuestionController();
    const uiHooks = {
      showApprovalPanel: mock(),
      hideApprovalPanel: mock(),
      showQuestionDialog: mock(),
      hideQuestionDialog: mock(),
    };

    registerReverseRPCHandlers(approvalController, questionController, uiHooks);

    const approvalPending = approvalController.show({
      id: 'approval-1',
      tool_call_id: 'tc-1',
      tool_name: 'Bash',
      action: 'run',
      description: '',
      display: [],
      choices: [],
    });
    const questionPending = questionController.show({
      id: 'question-1',
      tool_call_id: 'tq-1',
      questions: [],
    });

    questionController.cancelAll('closed');
    await expect(questionPending).resolves.toEqual({ answers: [] });
    expect(uiHooks.hideQuestionDialog).not.toHaveBeenCalled();

    approvalController.respond({ decision: 'approved' });
    await expect(approvalPending).resolves.toEqual({ decision: 'approved' });
    expect(uiHooks.showQuestionDialog).not.toHaveBeenCalled();
  });

  it('clears active and queued modals without showing queued entries', async () => {
    const approvalController = new ApprovalController();
    const questionController = new QuestionController();
    const uiHooks = {
      showApprovalPanel: mock(),
      hideApprovalPanel: mock(),
      showQuestionDialog: mock(),
      hideQuestionDialog: mock(),
    };

    const disposers = registerReverseRPCHandlers(approvalController, questionController, uiHooks);

    const approvalPending = approvalController.show({
      id: 'approval-1',
      tool_call_id: 'tc-1',
      tool_name: 'Bash',
      action: 'run',
      description: '',
      display: [],
      choices: [],
    });
    const questionPending = questionController.show({
      id: 'question-1',
      tool_call_id: 'tq-1',
      questions: [],
    });

    for (const dispose of disposers) dispose();
    expect(uiHooks.hideApprovalPanel).toHaveBeenCalledTimes(1);
    expect(uiHooks.showQuestionDialog).not.toHaveBeenCalled();

    approvalController.cancelAll('closed');
    questionController.cancelAll('closed');
    await expect(approvalPending).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'closed',
    });
    await expect(questionPending).resolves.toEqual({ answers: [] });
    expect(uiHooks.hideQuestionDialog).not.toHaveBeenCalled();
  });
});
