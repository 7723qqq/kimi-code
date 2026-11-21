export type TodoCompletionConcern =
  | 'unsupported_context_stop'
  | 'unfulfilled_continuation'
  | 'deferred_remaining_work';

export const TODO_COMPLETION_AUDIT_VARIANT = 'todo_completion_audit';
export const TODO_COMPLETION_REJECTED_WARNING = 'todo-completion-rejected';
export const TODO_COMPLETION_AUDIT_PROMPT =
  'The runtime completion audit found a non-terminal closing reply while authorized work remains. ' +
  'Re-read the latest user request and the outstanding work. If execution is requested and authorized, ' +
  'perform the next concrete tool action now instead of ending with an apology, plan, promise to continue, ' +
  'or a next-turn/batch handoff. A green build or completed batch is a verification point, not permission ' +
  'to stop the remaining task. Recover missing source and prior results with tools; cumulative token usage ' +
  'or past compaction does not establish an exhausted context window. If the user requested only an ' +
  'explanation, status report, or plan, provide that without promising or performing unauthorized work. ' +
  'If genuinely blocked, identify the actual observable blocker or required user decision. Honor ' +
  'cancellation, permissions, and limits explicitly reported by the runtime. Keep incomplete todos open; ' +
  'never mark them done merely to pass this audit.';

function proseOnly(text: string): string {
  return text
    .normalize('NFKC')
    .replaceAll(/```[\s\S]*?(?:```|$)/g, '')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .trim();
}

export function isExplanationOnlyRequest(text: string): boolean {
  const prose = proseOnly(text);
  if (
    /^(?:先)?(?:暂停|停下|停止|取消)|^(?:stop|pause|cancel)\b|只(?:需要|要)?(?:解释|汇报|总结|报告|告诉|计划)|仅(?:解释|汇报|总结|报告|计划)|不要(?:继续|修改|执行|实施)|先(?:给|做|制定)[^。\n]{0,12}(?:计划|方案)|\b(?:report|explain|plan)\s+only\b|\bplan first\b|\b(?:do not|don't)\s+(?:continue|execute|implement)\b/i.test(
      prose,
    )
  )
    return true;
  return (
    /为什么|为何|解释|\b(?:why|explain)\b/i.test(prose) &&
    !/修复|实现|修改|完成|杜绝|\b(?:fix|implement|change|prevent|eliminate|finish)\b/i.test(prose)
  );
}

export function isWorkContinuationRequest(text: string): boolean {
  const prose = proseOnly(text);
  if (isExplanationOnlyRequest(prose)) return false;
  return (
    /^(?:继续|接着|continue\b|go on\b|carry on\b)/i.test(prose) ||
    /(?:你(?:是)?主动停|就是你.*停|\byou (?:chose to |actively )?stopped\b)/i.test(prose)
  );
}

export function todoCompletionConcern(input: {
  readonly text: string;
  readonly continuationRequested: boolean;
  readonly updatedInTurn: boolean;
  readonly hasOpenTodos: boolean;
  readonly performedToolWork: boolean;
  readonly hasPriorToolWork: boolean;
  readonly explanationOnly: boolean;
}): TodoCompletionConcern | undefined {
  if (input.explanationOnly) return undefined;
  const workContext =
    input.hasOpenTodos ||
    input.performedToolWork ||
    (input.continuationRequested && input.hasPriorToolWork);
  const workScope = input.updatedInTurn || input.performedToolWork || input.continuationRequested;
  if (!workContext || !workScope) return undefined;
  const prose = proseOnly(input.text);
  if (prose.length === 0) return undefined;
  const claimsLimit = prose
    .split(/[。!?！？\n]/)
    .some(
      (sentence) =>
        !/(?:不是(?:因为)?|并非|没有|不存在)\s*(?:上下文|预算|token|令牌)|\b(?:not|no|never|did not|didn't)\s+(?:because of |due to |run(?:ning)? out of )?(?:an? )?(?:context|tokens?|budget)/i.test(
          sentence,
        ) &&
        /(?:上下文(?:窗口)?|context(?: window)?|(?:剩余|remaining)[^。\n]{0,20}(?:tokens?|预算)|token(?:\s+budget)?|令牌预算)[^。\n]{0,60}(?:用尽|耗尽|不足|见底|不够|已满|exhausted|insufficient|nearly full|almost full|too (?:little|small)|running low)|\b(?:out of|exhausted)\s+(?:context|tokens?|(?:my |the )?budget)/i.test(
          sentence,
        ),
    );
  const stops =
    /我[^。\n]{0,35}(?:停|不能继续|无法继续)|往下写[^。\n]{0,20}盲改|不足以完成|\bI\s+(?:(?:must|need to|have to|chose to)\s+)?stop|\b(?:cannot|can't|unable to)\s+(?:continue|proceed|finish)/i.test(
      prose,
    );
  if (claimsLimit && stops) return 'unsupported_context_stop';
  if (
    /(?:^|\n)\s*(?:下一轮|下轮|下个回合|下一回合)(?:继续|再做)?\s*[:：]|(?:^|\n)\s*(?:next (?:turn|round|iteration)|in the next (?:turn|round|iteration))\s*[:：]/i.test(
      prose,
    )
  ) {
    return 'deferred_remaining_work';
  }
  if (!input.continuationRequested) return undefined;
  const last = prose
    .split(/[。!?！？\n]/)
    .filter((part) => part.trim().length > 0)
    .slice(-2)
    .join(' ');
  if (/如果|等待|等你|批准后|确认后|\b(?:once|if|before|after|when|until)\b/i.test(last))
    return undefined;
  if (
    /(?:现在|接下来|马上)[^。\n]{0,30}(?:继续|开始|执行|动手|推进)|继续[，,\s]*(?:不停下|不暂停)|\b(?:I(?:'ll| will)|let me|I am going to|I'm going to)[^.!?\n]{0,80}(?:continue|start|proceed|implement|locate|read|work)|\bcontinuing now\b/i.test(
      last,
    )
  ) {
    return 'unfulfilled_continuation';
  }
  return undefined;
}
