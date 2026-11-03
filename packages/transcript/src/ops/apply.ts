import type { TranscriptAttachment } from '../model/attachment';
import type { TranscriptFrame } from '../model/frame';
import type { AttachmentId, InteractionId, PromptId, TaskId, TodoId, TurnId } from '../model/ids';
import { turnOrdinal } from '../model/ids';
import type { TranscriptInteraction } from '../model/interaction';
import { itemId } from '../model/item';
import type { TranscriptItem } from '../model/item';
import type { TranscriptMeta, TranscriptMetaMerge } from '../model/meta';
import type { TranscriptPrompt } from '../model/prompt';
import type { TranscriptTask } from '../model/task';
import type { TranscriptTodo } from '../model/todo';
import type { TranscriptStep, TranscriptTurn } from '../model/turn';
import type {
  AgentTranscriptSnapshot,
  AppendOp,
  StepHeader,
  TranscriptOperation,
  TurnHeader,
} from './operation';

export interface AgentState {
  readonly items: readonly TranscriptItem[];
  readonly tasks: ReadonlyMap<TaskId, TranscriptTask>;
  readonly interactions: ReadonlyMap<InteractionId, TranscriptInteraction>;
  readonly attachments: ReadonlyMap<AttachmentId, TranscriptAttachment>;
  readonly todos: ReadonlyMap<TodoId, TranscriptTodo>;
  readonly prompts: ReadonlyMap<PromptId, TranscriptPrompt>;
  readonly meta: TranscriptMeta;
  readonly pendingInteractions: ReadonlySet<InteractionId>;
  readonly hasMoreOlder: boolean;
}

export const EMPTY_AGENT_STATE: AgentState = {
  items: [],
  tasks: new Map(),
  interactions: new Map(),
  attachments: new Map(),
  todos: new Map(),
  prompts: new Map(),
  meta: {},
  pendingInteractions: new Set(),
  hasMoreOlder: false,
};

export interface ApplyOpResult {
  readonly changed: boolean;
  readonly gap?: { readonly expected: number; readonly got: number };
}

export interface TranscriptDocumentInit {
  readonly items: readonly TranscriptItem[];
  readonly tasks: readonly TranscriptTask[];
  readonly interactions: readonly TranscriptInteraction[];
  readonly attachments: readonly TranscriptAttachment[];
  readonly todos: readonly TranscriptTodo[];
  readonly prompts?: readonly TranscriptPrompt[];
  readonly meta: TranscriptMeta;
  readonly pendingInteractions?: readonly InteractionId[];
  readonly hasMoreOlder?: boolean;
}

export class TranscriptDocument {
  #order: string[] = [];
  #entries = new Map<string, TranscriptItem>();
  #tasks = new Map<TaskId, TranscriptTask>();
  #interactions = new Map<InteractionId, TranscriptInteraction>();
  #attachments = new Map<AttachmentId, TranscriptAttachment>();
  #todos = new Map<TodoId, TranscriptTodo>();
  #prompts = new Map<PromptId, TranscriptPrompt>();
  #meta: TranscriptMeta = {};
  #pendingInteractions = new Set<InteractionId>();
  #hasMoreOlder = false;
  #itemsCache: readonly TranscriptItem[] | undefined;
  #viewCache: AgentState | undefined;

  constructor(init?: TranscriptDocumentInit) {
    if (init === undefined) return;
    this.#order = init.items.map(itemId);
    this.#entries = new Map(init.items.map((item) => [itemId(item), item]));
    this.#tasks = new Map(init.tasks.map((task) => [task.taskId, task]));
    this.#interactions = new Map(
      init.interactions.map((interaction) => [interaction.interactionId, interaction]),
    );
    this.#attachments = new Map(
      init.attachments.map((attachment) => [attachment.attachmentId, attachment]),
    );
    this.#todos = new Map(init.todos.map((todo) => [todo.todoId, todo]));
    this.#prompts = new Map((init.prompts ?? []).map((prompt) => [prompt.promptId, prompt]));
    this.#meta = init.meta;
    this.#pendingInteractions = new Set(init.pendingInteractions ?? []);
    this.#hasMoreOlder = init.hasMoreOlder ?? false;
  }

  get items(): readonly TranscriptItem[] {
    if (this.#itemsCache === undefined) {
      this.#itemsCache = this.#order.map((id) => {
        const entry = this.#entries.get(id);
        if (entry === undefined) throw new Error(`transcript: missing entry for item ${id}`);
        return entry;
      });
    }
    return this.#itemsCache;
  }

  get tasks(): ReadonlyMap<TaskId, TranscriptTask> {
    return this.#tasks;
  }

  get interactions(): ReadonlyMap<InteractionId, TranscriptInteraction> {
    return this.#interactions;
  }

  get attachments(): ReadonlyMap<AttachmentId, TranscriptAttachment> {
    return this.#attachments;
  }

  get todos(): ReadonlyMap<TodoId, TranscriptTodo> {
    return this.#todos;
  }

  get prompts(): ReadonlyMap<PromptId, TranscriptPrompt> {
    return this.#prompts;
  }

  get meta(): TranscriptMeta {
    return this.#meta;
  }

  get pendingInteractions(): ReadonlySet<InteractionId> {
    return this.#pendingInteractions;
  }

  get hasMoreOlder(): boolean {
    return this.#hasMoreOlder;
  }

  getTurn(turnId: TurnId): TranscriptTurn | undefined {
    const entry = this.#entries.get(turnId);
    return entry?.kind === 'turn' ? entry : undefined;
  }

  read(): AgentState {
    if (this.#viewCache === undefined) {
      this.#viewCache = {
        items: this.items,
        tasks: this.#tasks,
        interactions: this.#interactions,
        attachments: this.#attachments,
        todos: this.#todos,
        prompts: this.#prompts,
        meta: this.#meta,
        pendingInteractions: this.#pendingInteractions,
        hasMoreOlder: this.#hasMoreOlder,
      };
    }
    return this.#viewCache;
  }

  snapshot(window?: { tailTurns: number }): AgentTranscriptSnapshot {
    let items = this.items;
    let hasMoreOlder = this.#hasMoreOlder;
    if (window !== undefined) {
      const turnCount = items.reduce((n, entry) => (entry.kind === 'turn' ? n + 1 : n), 0);
      if (turnCount > window.tailTurns) {
        const skip = turnCount - window.tailTurns;
        const kept: TranscriptItem[] = [];
        let seen = 0;
        for (const entry of items) {
          if (entry.kind === 'turn') {
            seen += 1;
            if (seen <= skip) continue;
            kept.push(entry);
          } else if (seen > skip) {
            kept.push(entry);
          }
        }
        items = kept;
        hasMoreOlder = true;
      }
    }
    return {
      items,
      tasks: [...this.#tasks.values()],
      interactions: [...this.#interactions.values()],
      attachments: [...this.#attachments.values()],
      todos: [...this.#todos.values()],
      prompts: [...this.#prompts.values()],
      meta: this.#meta,
      hasMoreOlder,
    };
  }

  prependWindow(items: readonly TranscriptItem[], hasMoreOlder: boolean): boolean {
    const fresh = items.filter((item) => !this.#entries.has(itemId(item)));
    if (fresh.length === 0) {
      if (hasMoreOlder === this.#hasMoreOlder) return false;
      this.#hasMoreOlder = hasMoreOlder;
      this.#viewCache = undefined;
      return true;
    }
    for (const item of fresh) this.#entries.set(itemId(item), item);
    this.#order = [...fresh.map(itemId), ...this.#order];
    this.#hasMoreOlder = hasMoreOlder;
    this.#touchItems();
    return true;
  }

  apply(op: TranscriptOperation): ApplyOpResult {
    switch (op.op) {
      case 'reset':
        return this.#applyReset(op);
      case 'turn.upsert':
        return this.#applyTurnUpsert(op.turn);
      case 'step.upsert':
        return this.#applyStepUpsert(op.turnId, op.step);
      case 'frame.upsert':
        return this.#applyFrameUpsert(op);
      case 'append':
        return this.#applyAppend(op);
      case 'marker.upsert':
        return this.#applyItemUpsert(op.item, op.item.markerId, op.beforeTurn);
      case 'taskref.upsert':
        return this.#applyItemUpsert(op.item, op.item.refId, op.beforeTurn);
      case 'task.upsert':
        return this.#applyTaskUpsert(op.task);
      case 'interaction.upsert':
        return this.#applyInteractionUpsert(op.interaction);
      case 'attachment.upsert':
        return this.#applyAttachmentUpsert(op.attachment);
      case 'todo.upsert':
        return this.#applyTodoUpsert(op.todo);
      case 'prompt.upsert':
        return this.#applyPromptUpsert(op.prompt);
      case 'meta.merge':
        return this.#applyMetaMerge(op.meta);
      case 'items.remove':
        return this.#applyItemsRemove(op.ids);
    }
  }

  #touchItems(): void {
    this.#itemsCache = undefined;
    this.#viewCache = undefined;
  }

  #touchView(): void {
    this.#viewCache = undefined;
  }

  #insertEntry(id: string, item: TranscriptItem, beforeTurn?: number): void {
    if (beforeTurn === undefined) {
      this.#order.push(id);
    } else {
      let at = this.#order.length;
      for (const [index, orderId] of this.#order.entries()) {
        const entry = this.#entries.get(orderId);
        if (entry?.kind === 'turn' && entry.ordinal >= beforeTurn) {
          at = index;
          break;
        }
      }
      this.#order.splice(at, 0, id);
    }
    this.#entries.set(id, item);
    this.#touchItems();
  }

  #insertTurn(turn: TranscriptTurn): void {
    let at = this.#order.length;
    for (const [index, id] of this.#order.entries()) {
      const entry = this.#entries.get(id);
      if (entry?.kind === 'turn' && entry.ordinal > turn.ordinal) {
        at = index;
        break;
      }
    }
    this.#order.splice(at, 0, turn.turnId);
    this.#entries.set(turn.turnId, turn);
    this.#touchItems();
  }

  #replaceTurn(turnId: TurnId, turn: TranscriptTurn): void {
    this.#entries.set(turnId, turn);
    this.#touchItems();
  }

  #applyReset(op: Extract<TranscriptOperation, { op: 'reset' }>): ApplyOpResult {
    const pending = new Set<InteractionId>();
    for (const interaction of op.snapshot.interactions) {
      if (interaction.state === 'pending') pending.add(interaction.interactionId);
    }
    this.#order = op.snapshot.items.map(itemId);
    this.#entries = new Map(op.snapshot.items.map((item) => [itemId(item), item]));
    this.#tasks = new Map(op.snapshot.tasks.map((task) => [task.taskId, task]));
    this.#interactions = new Map(
      op.snapshot.interactions.map((interaction) => [interaction.interactionId, interaction]),
    );
    this.#attachments = new Map(
      op.snapshot.attachments.map((attachment) => [attachment.attachmentId, attachment]),
    );
    this.#todos = new Map(op.snapshot.todos.map((todo) => [todo.todoId, todo]));
    this.#prompts = new Map(op.snapshot.prompts.map((prompt) => [prompt.promptId, prompt]));
    this.#meta = op.snapshot.meta;
    this.#pendingInteractions = pending;
    this.#hasMoreOlder = op.snapshot.hasMoreOlder ?? false;
    this.#touchItems();
    return { changed: true };
  }

  #applyTurnUpsert(header: TurnHeader): ApplyOpResult {
    const existing = this.getTurn(header.turnId);
    if (existing !== undefined) {
      if (turnEquals(existing, header)) return { changed: false };
      this.#replaceTurn(header.turnId, turnHeaderToTurn(header, existing.steps));
      return { changed: true };
    }
    this.#insertTurn(turnHeaderToTurn(header, []));
    return { changed: true };
  }

  #applyStepUpsert(turnId: TurnId, header: StepHeader): ApplyOpResult {
    const existing = this.getTurn(turnId);
    const turn = existing ?? skeletonTurn(turnId);
    const stepIndex = turn.steps.findIndex((step) => step.stepId === header.stepId);
    let steps: readonly TranscriptStep[];
    if (stepIndex >= 0) {
      const current = turn.steps[stepIndex];
      if (current && stepEquals(current, header)) return { changed: false };
      steps = turn.steps.map((step) =>
        step.stepId === header.stepId
          ? { ...header, kind: 'step' as const, frames: step.frames }
          : step,
      );
    } else {
      steps = [...turn.steps, { ...header, kind: 'step' as const, frames: [] }].toSorted(
        (a, b) => a.ordinal - b.ordinal,
      );
    }
    const nextTurn: TranscriptTurn = { ...turn, steps: [...steps] };
    if (existing === undefined) this.#insertTurn(nextTurn);
    else this.#replaceTurn(turnId, nextTurn);
    return { changed: true };
  }

  #applyFrameUpsert(op: Extract<TranscriptOperation, { op: 'frame.upsert' }>): ApplyOpResult {
    const existing = this.getTurn(op.turnId);
    const turn = existing ?? skeletonTurn(op.turnId);
    const existingStep = turn.steps.find((entry) => entry.stepId === op.stepId);
    const step = existingStep ?? skeletonStep(op.stepId, op.turnId);
    const frameIndex = step.frames.findIndex((frame) => frame.frameId === op.frame.frameId);
    let frames: readonly TranscriptFrame[];
    if (frameIndex >= 0) {
      const current = step.frames[frameIndex];
      if (current !== undefined && frameEquals(current, op.frame)) return { changed: false };
      frames = step.frames.map((frame) => (frame.frameId === op.frame.frameId ? op.frame : frame));
    } else {
      frames = [...step.frames, op.frame];
    }
    const nextStep: TranscriptStep = { ...step, frames: [...frames] };
    const steps =
      existingStep === undefined
        ? [...turn.steps, nextStep].toSorted((a, b) => a.ordinal - b.ordinal)
        : turn.steps.map((entry) => (entry.stepId === op.stepId ? nextStep : entry));
    const nextTurn: TranscriptTurn = { ...turn, steps };
    if (existing === undefined) this.#insertTurn(nextTurn);
    else this.#replaceTurn(op.turnId, nextTurn);
    return { changed: true };
  }

  #applyAppend(op: AppendOp): ApplyOpResult {
    if (op.target.type === 'task') return this.#applyTaskAppend(op);
    const { turnId, stepId, frameId } = op.target;
    const turn = this.getTurn(turnId);
    const step = turn?.steps.find((entry) => entry.stepId === stepId);
    const frame = step?.frames.find((entry) => entry.frameId === frameId);
    if (!turn || !step || !frame || (frame.kind !== 'text' && frame.kind !== 'thinking')) {
      return { changed: false, gap: { expected: 0, got: op.offset } };
    }
    const merged = appendAtOffset(frame.text, op.offset, op.text);
    if (merged.gap) return { changed: false, gap: merged.gap };
    if (!merged.changed) return { changed: false };
    const nextFrame = { ...frame, text: merged.text };
    const nextStep: TranscriptStep = {
      ...step,
      frames: step.frames.map((entry) => (entry.frameId === frameId ? nextFrame : entry)),
    };
    const nextTurn: TranscriptTurn = {
      ...turn,
      steps: turn.steps.map((entry) => (entry.stepId === stepId ? nextStep : entry)),
    };
    this.#replaceTurn(turnId, nextTurn);
    return { changed: true };
  }

  #applyTaskAppend(op: AppendOp): ApplyOpResult {
    if (op.target.type !== 'task') throw new Error('unreachable');
    const taskId = op.target.taskId;
    const task = this.#tasks.get(taskId);
    const current = task?.outputTail ?? '';
    const merged = appendAtOffset(current, op.offset, op.text);
    if (merged.gap) return { changed: false, gap: merged.gap };
    if (!merged.changed) return { changed: false };
    const nextTask: TranscriptTask = task
      ? { ...task, outputTail: merged.text }
      : { taskId, kind: 'other', state: 'running', detached: false, outputTail: merged.text };
    const tasks = new Map(this.#tasks);
    tasks.set(taskId, nextTask);
    this.#tasks = tasks;
    this.#touchView();
    return { changed: true };
  }

  #applyItemUpsert(item: TranscriptItem, id: string, beforeTurn?: number): ApplyOpResult {
    const existing = this.#entries.get(id);
    if (existing !== undefined) {
      if (existing === item) return { changed: false };
      this.#entries.set(id, item);
      this.#touchItems();
      return { changed: true };
    }
    this.#insertEntry(id, item, beforeTurn);
    return { changed: true };
  }

  #applyItemsRemove(ids: readonly string[]): ApplyOpResult {
    const drop = new Set(ids);
    const kept = this.#order.filter((id) => !drop.has(id));
    if (kept.length === this.#order.length) return { changed: false };
    const removedTurns: TranscriptTurn[] = [];
    for (const id of drop) {
      const entry = this.#entries.get(id);
      if (entry?.kind === 'turn') removedTurns.push(entry);
    }
    this.#order = kept;
    for (const id of drop) this.#entries.delete(id);
    if (removedTurns.length > 0) {
      const anchoredToolCallIds = new Set<string>();
      for (const turn of removedTurns) {
        for (const step of turn.steps) {
          for (const frame of step.frames) {
            if (frame.kind === 'tool') anchoredToolCallIds.add(frame.toolCallId);
          }
        }
      }
      const nextPending = new Set(this.#pendingInteractions);
      const deadEntityIds = new Set<InteractionId>();
      for (const interaction of this.#interactions.values()) {
        if (interaction.toolCallId !== undefined && anchoredToolCallIds.has(interaction.toolCallId)) {
          deadEntityIds.add(interaction.interactionId);
          nextPending.delete(interaction.interactionId);
        }
      }
      if (deadEntityIds.size > 0) {
        const nextInteractions = new Map(this.#interactions);
        for (const id of deadEntityIds) nextInteractions.delete(id);
        this.#interactions = nextInteractions;
      }
      this.#pendingInteractions = nextPending;
    }
    this.#touchItems();
    return { changed: true };
  }

  #applyTaskUpsert(task: TranscriptTask): ApplyOpResult {
    const current = this.#tasks.get(task.taskId);
    if (current && taskEquals(current, task)) return { changed: false };
    const tasks = new Map(this.#tasks);
    tasks.set(task.taskId, task);
    this.#tasks = tasks;
    this.#touchView();
    return { changed: true };
  }

  #applyInteractionUpsert(interaction: TranscriptInteraction): ApplyOpResult {
    const current = this.#interactions.get(interaction.interactionId);
    if (current && interactionEquals(current, interaction)) return { changed: false };
    const interactions = new Map(this.#interactions);
    interactions.set(interaction.interactionId, interaction);
    this.#interactions = interactions;
    if (interaction.state === 'pending') {
      if (!this.#pendingInteractions.has(interaction.interactionId)) {
        const next = new Set(this.#pendingInteractions);
        next.add(interaction.interactionId);
        this.#pendingInteractions = next;
      }
    } else if (this.#pendingInteractions.has(interaction.interactionId)) {
      const next = new Set(this.#pendingInteractions);
      next.delete(interaction.interactionId);
      this.#pendingInteractions = next;
    }
    this.#touchView();
    return { changed: true };
  }

  #applyAttachmentUpsert(attachment: TranscriptAttachment): ApplyOpResult {
    const current = this.#attachments.get(attachment.attachmentId);
    if (current && attachmentEquals(current, attachment)) return { changed: false };
    const attachments = new Map(this.#attachments);
    attachments.set(attachment.attachmentId, attachment);
    this.#attachments = attachments;
    this.#touchView();
    return { changed: true };
  }

  #applyTodoUpsert(todo: TranscriptTodo): ApplyOpResult {
    const current = this.#todos.get(todo.todoId);
    if (current && todoEquals(current, todo)) return { changed: false };
    const todos = new Map(this.#todos);
    todos.set(todo.todoId, todo);
    this.#todos = todos;
    this.#touchView();
    return { changed: true };
  }

  #applyPromptUpsert(prompt: TranscriptPrompt): ApplyOpResult {
    const current = this.#prompts.get(prompt.promptId);
    if (current && promptEquals(current, prompt)) return { changed: false };
    const prompts = new Map(this.#prompts);
    prompts.set(prompt.promptId, prompt);
    this.#prompts = prompts;
    this.#touchView();
    return { changed: true };
  }

  #applyMetaMerge(meta: TranscriptMetaMerge): ApplyOpResult {
    const modes =
      meta.modes !== undefined
        ? {
            plan: meta.modes.plan === null ? undefined : (meta.modes.plan ?? this.#meta.modes?.plan),
            spec: meta.modes.spec === null ? undefined : (meta.modes.spec ?? this.#meta.modes?.spec),
            swarm:
              meta.modes.swarm === null
                ? undefined
                : (meta.modes.swarm ?? this.#meta.modes?.swarm),
            'hello-world':
              meta.modes['hello-world'] === null
                ? undefined
                : meta.modes['hello-world'] === undefined
                  ? this.#meta.modes?.['hello-world']
                  : {
                      trigger:
                        meta.modes['hello-world'].trigger ??
                        this.#meta.modes?.['hello-world']?.trigger,
                      stage:
                        meta.modes['hello-world'].stage ?? this.#meta.modes?.['hello-world']?.stage,
                    },
            tower:
              meta.modes.tower === null
                ? undefined
                : (meta.modes.tower ?? this.#meta.modes?.tower),
          }
        : this.#meta.modes;
    const agent =
      meta.agent !== undefined ? { ...this.#meta.agent, ...meta.agent } : this.#meta.agent;
    const next: TranscriptMeta = {
      goal: meta.goal === null ? undefined : (meta.goal ?? this.#meta.goal),
      activity: meta.activity ?? this.#meta.activity,
      modes:
        modes !== undefined &&
        modes.plan === undefined &&
        modes.spec === undefined &&
        modes.swarm === undefined &&
        modes['hello-world'] === undefined &&
        modes.tower === undefined
          ? undefined
          : modes,
      agent,
    };
    if (
      contentEqual(next.goal, this.#meta.goal) &&
      next.activity === this.#meta.activity &&
      contentEqual(next.modes, this.#meta.modes) &&
      contentEqual(next.agent, this.#meta.agent)
    ) {
      return { changed: false };
    }
    this.#meta = next;
    this.#touchView();
    return { changed: true };
  }
}

function turnHeaderToTurn(header: TurnHeader, steps: readonly TranscriptStep[]): TranscriptTurn {
  return { ...header, kind: 'turn', steps: [...steps] };
}

function skeletonTurn(turnId: TurnId): TranscriptTurn {
  return {
    kind: 'turn',
    turnId,
    ordinal: turnOrdinal(turnId),
    state: 'running',
    origin: { kind: 'other' },
    steps: [],
  };
}

function skeletonStep(stepId: string, turnId: TurnId): TranscriptStep {
  const ordinal = Number(stepId.slice(turnId.length + 1)) || 0;
  return { kind: 'step', stepId, turnId, ordinal, state: 'running', frames: [] };
}

function turnEquals(turn: TranscriptTurn, header: TurnHeader): boolean {
  return (
    turn.ordinal === header.ordinal &&
    turn.triggerPromptId === header.triggerPromptId &&
    turn.state === header.state &&
    turn.prompt === header.prompt &&
    turn.attachmentIds === header.attachmentIds &&
    turn.startedAt === header.startedAt &&
    turn.endedAt === header.endedAt &&
    turn.origin.kind === header.origin.kind &&
    turn.origin.payload === header.origin.payload &&
    turn.usage === header.usage &&
    turn.durationMs === header.durationMs &&
    turn.error === header.error &&
    turn.wedged === header.wedged
  );
}

function stepEquals(step: TranscriptStep, header: StepHeader): boolean {
  return (
    step.ordinal === header.ordinal &&
    step.state === header.state &&
    step.startedAt === header.startedAt &&
    step.endedAt === header.endedAt &&
    step.usage === header.usage &&
    step.finishReason === header.finishReason &&
    step.llmTiming === header.llmTiming &&
    step.retry === header.retry &&
    step.endReason === header.endReason &&
    step.endMessage === header.endMessage
  );
}

function frameEquals(a: TranscriptFrame, b: TranscriptFrame): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'text' && b.kind === 'text') {
    return (
      a.text === b.text &&
      a.role === b.role &&
      a.attachmentIds === b.attachmentIds &&
      a.taskId === b.taskId
    );
  }
  if (a.kind === 'thinking' && b.kind === 'thinking') return a.text === b.text;
  if (a.kind === 'tool' && b.kind === 'tool') {
    return (
      a.state === b.state &&
      a.toolCallId === b.toolCallId &&
      a.name === b.name &&
      a.view === b.view &&
      a.input === b.input &&
      a.output === b.output &&
      a.display === b.display &&
      a.error === b.error &&
      a.inputText === b.inputText &&
      a.progress === b.progress &&
      a.taskId === b.taskId &&
      a.approvalId === b.approvalId &&
      a.todoId === b.todoId &&
      a.agentRefs === b.agentRefs
    );
  }
  if (a.kind === 'notice' && b.kind === 'notice') {
    return a.message === b.message && a.level === b.level && a.detail === b.detail;
  }
  return false;
}

export function appendAtOffset(
  local: string,
  offset: number,
  chunk: string,
): { text: string; changed: boolean; gap?: { expected: number; got: number } } {
  if (offset > local.length)
    return { text: local, changed: false, gap: { expected: local.length, got: offset } };
  if (local.slice(offset, offset + chunk.length) === chunk) {
    return { text: local, changed: false };
  }
  const overlap = local.length - offset;
  if (local.slice(offset) !== chunk.slice(0, overlap)) {
    return { text: local, changed: false, gap: { expected: local.length, got: offset } };
  }
  const novel = overlap > 0 ? chunk.slice(overlap) : chunk;
  if (novel.length === 0) return { text: local, changed: false };
  return { text: local.slice(0, offset) + chunk, changed: true };
}

function interactionEquals(a: TranscriptInteraction, b: TranscriptInteraction): boolean {
  return (
    a.interactionKind === b.interactionKind &&
    a.toolCallId === b.toolCallId &&
    a.state === b.state &&
    a.request === b.request &&
    a.response === b.response
  );
}

function attachmentEquals(a: TranscriptAttachment, b: TranscriptAttachment): boolean {
  return (
    a.mediaType === b.mediaType &&
    a.name === b.name &&
    a.size === b.size &&
    a.source === b.source &&
    a.placeholder === b.placeholder
  );
}

function todoEquals(a: TranscriptTodo, b: TranscriptTodo): boolean {
  return a.items === b.items && a.updatedAt === b.updatedAt;
}

function promptEquals(a: TranscriptPrompt, b: TranscriptPrompt): boolean {
  return (
    a.status === b.status &&
    a.userMessageId === b.userMessageId &&
    a.content === b.content &&
    a.createdAt === b.createdAt &&
    a.finishedAt === b.finishedAt &&
    a.steeredAt === b.steeredAt
  );
}

function taskEquals(a: TranscriptTask, b: TranscriptTask): boolean {
  return (
    a.kind === b.kind &&
    a.state === b.state &&
    a.detached === b.detached &&
    a.description === b.description &&
    a.agentId === b.agentId &&
    a.outputTail === b.outputTail &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.resultSummary === b.resultSummary &&
    a.error === b.error &&
    a.stateReason === b.stateReason &&
    a.usage === b.usage &&
    a.model === b.model &&
    a.thinkingEffort === b.thinkingEffort
  );
}

function contentEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  return keysA.every((key) => contentEqual(recordA[key], recordB[key]));
}
