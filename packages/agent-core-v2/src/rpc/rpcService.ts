import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentBackgroundService } from '#/background';
import { IAgentContextMemoryService } from '#/contextMemory';
import { IAgentContextSizeService } from '#/contextSize';
import { IAgentFileToolsService } from '#/fileTools';
import { IAgentFullCompactionService } from '#/fullCompaction';
import { IAgentGoalService } from '#/goal';
import { userCancellationReason } from '#/_base/utils/abort';
import { IAgentPermissionGate } from '#/permissionGate';
import { IAgentPermissionModeService } from '#/permissionMode/permissionMode';
import { IAgentPlanService } from '../plan';
import { IAgentProfileService } from '#/profile';
import { IAgentPromptService } from '#/prompt';
import { IAgentQuestionToolsService } from '#/question';
import { IAgentShellToolsService } from '#/shellTools';
import { IAgentSkillService } from '#/skill';
import { ISessionSubagentHost } from '#/subagentHost';
import { IAgentSwarmService } from '../swarm';
import { ITelemetryService } from '#/telemetry';
import { IAgentToolRegistryService } from '#/toolRegistry';
import { IAgentTurnService } from '../turn';
import { IAgentUsageService } from '#/usage';
import { IAgentUserToolService } from '#/userTool';
import { IAgentWebService } from '#/web';
import type {
  ActivateSkillPayload,
  BeginCompactionPayload,
  CancelPayload,
  CancelPlanPayload,
  CreateGoalPayload,
  DetachBackgroundPayload,
  EmptyPayload,
  EnterSwarmPayload,
  GetBackgroundOutputPayload,
  GetBackgroundPayload,
  PromptLaunchResult,
  PromptPayload,
  RegisterToolPayload,
  SetActiveToolsPayload,
  SetModelPayload,
  SetPermissionPayload,
  SetThinkingPayload,
  SteerPayload,
  StopBackgroundPayload,
  UndoHistoryPayload,
  UnregisterToolPayload,
} from './core-api';
import { IAgentRPCService } from './rpc';

export class AgentRPCService implements IAgentRPCService {
  declare readonly _serviceBrand: undefined;
  constructor(
    @IAgentPromptService private readonly promptService: IAgentPromptService,
    @IAgentTurnService private readonly turnService: IAgentTurnService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
    @IAgentPermissionGate private readonly permission: IAgentPermissionGate,
    @IAgentPlanService private readonly planMode: IAgentPlanService,
    @IAgentSwarmService private readonly swarmMode: IAgentSwarmService,
    @IAgentFullCompactionService private readonly fullCompaction: IAgentFullCompactionService,
    @IAgentUserToolService private readonly userTools: IAgentUserToolService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentFileToolsService private readonly fileTools: IAgentFileToolsService,
    @IAgentShellToolsService private readonly shellTools: IAgentShellToolsService,
    @IAgentBackgroundService private readonly background: IAgentBackgroundService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentSkillService private readonly skills: IAgentSkillService,
    @ISessionSubagentHost private readonly subagentHost: ISessionSubagentHost,
    @IAgentUsageService private readonly usage: IAgentUsageService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentGoalService private readonly goal: IAgentGoalService,
    @IAgentQuestionToolsService private readonly questionTools: IAgentQuestionToolsService,
    @IAgentWebService private readonly web: IAgentWebService,
  ) { }

  prompt(payload: PromptPayload): PromptLaunchResult | undefined {
    const turn = this.promptService.prompt({
      role: 'user',
      content: [...payload.input],
      toolCalls: [],
    });
    return turn === undefined ? undefined : { turn_id: turn.id };
  }

  steer(payload: SteerPayload): PromptLaunchResult | undefined {
    this.telemetry.track('input_steer', { parts: payload.input.length });
    const turn = this.promptService.steer({
      role: 'user',
      content: [...payload.input],
      toolCalls: [],
    });
    const id = turn?.id ?? this.turnService.getActiveTurn()?.id;
    return id === undefined ? undefined : { turn_id: id };
  }

  cancel({ turnId }: CancelPayload): void {
    if (this.turnService.getActiveTurn() !== undefined) {
      this.telemetry.track('cancel', { from: 'streaming' });
    }
    const turn = this.turnService.getActiveTurn();
    if (turn === undefined) return;
    if (turnId !== undefined && turn.id !== turnId) return;
    turn.abortController.abort(userCancellationReason());
  }

  undoHistory(payload: UndoHistoryPayload): number {
    return this.promptService.undo(payload.count);
  }

  setThinking(payload: SetThinkingPayload): void {
    this.profile.setThinking(payload.level);
  }

  setPermission(payload: SetPermissionPayload): void {
    const wasYolo = this.permissionMode.mode === 'yolo';
    const wasAuto = this.permissionMode.mode === 'auto';
    this.permissionMode.setMode(payload.mode);
    const enabled = this.permissionMode.mode === 'yolo';
    if (enabled !== wasYolo) {
      this.telemetry.track('yolo_toggle', { enabled });
    }
    const afkEnabled = this.permissionMode.mode === 'auto';
    if (afkEnabled !== wasAuto) {
      this.telemetry.track('afk_toggle', { enabled: afkEnabled });
    }
  }

  setModel(payload: SetModelPayload) {
    return this.profile.setModel(payload.model);
  }

  getModel(_payload: EmptyPayload): string {
    return this.profile.getModel();
  }

  enterPlan(_payload: EmptyPayload): Promise<void> {
    return this.planMode.enter();
  }

  cancelPlan(payload: CancelPlanPayload): void {
    this.planMode.cancel(payload.id);
  }

  clearPlan(_payload: EmptyPayload): Promise<void> {
    return this.planMode.clear();
  }

  enterSwarm(payload: EnterSwarmPayload): void {
    this.swarmMode.enter(payload.trigger);
  }

  exitSwarm(_payload: EmptyPayload): void {
    this.swarmMode.exit();
  }

  getSwarmMode(_payload: EmptyPayload): boolean {
    return this.swarmMode.isActive;
  }

  beginCompaction(payload: BeginCompactionPayload): void {
    this.fullCompaction.begin({ source: 'manual', instruction: payload.instruction });
  }

  cancelCompaction(_payload: EmptyPayload): void {
    if (this.fullCompaction.isCompacting) {
      this.telemetry.track('cancel', { from: 'compacting' });
    }
    this.fullCompaction.cancel();
  }

  registerTool(payload: RegisterToolPayload): void {
    this.userTools.register(payload);
  }

  unregisterTool(payload: UnregisterToolPayload): void {
    this.userTools.unregister(payload.name);
  }

  setActiveTools(payload: SetActiveToolsPayload): void {
    this.profile.update({ activeToolNames: payload.names });
  }

  stopBackground(payload: StopBackgroundPayload): void {
    void this.background.stop(payload.taskId, payload.reason);
  }

  detachBackground(payload: DetachBackgroundPayload) {
    return this.background.detach(payload.taskId);
  }

  clearContext(_payload: EmptyPayload): void {
    this.promptService.clear();
  }

  activateSkill(payload: ActivateSkillPayload): void {
    this.skills.activate(payload);
  }

  startBtw(_payload: EmptyPayload): Promise<string> {
    return this.subagentHost.startBtw();
  }

  createGoal(payload: CreateGoalPayload) {
    return this.goal.createGoal(payload);
  }

  getGoal(_payload: EmptyPayload) {
    return this.goal.getGoal();
  }

  pauseGoal(_payload: EmptyPayload) {
    return this.goal.pauseGoal();
  }

  resumeGoal(_payload: EmptyPayload) {
    return this.goal.resumeGoal();
  }

  cancelGoal(_payload: EmptyPayload) {
    return this.goal.cancelGoal();
  }

  getBackgroundOutput(payload: GetBackgroundOutputPayload): Promise<string> {
    return this.background.readOutput(payload.taskId, payload.tail);
  }

  getContext(_payload: EmptyPayload) {
    return {
      history: this.context.get(),
      tokenCount: this.contextSize.getStatus().contextTokens,
    };
  }

  getConfig(_payload: EmptyPayload) {
    return this.profile.data();
  }

  getPermission(_payload: EmptyPayload) {
    return this.permission.data();
  }

  getPlan(_payload: EmptyPayload) {
    return this.planMode.status();
  }

  getUsage(_payload: EmptyPayload) {
    return this.usage.status();
  }

  getTools(_payload: EmptyPayload) {
    return this.toolRegistry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      active: this.profile.isToolActive(tool.name, tool.source),
      source: tool.source,
    }));
  }

  getBackground(payload: GetBackgroundPayload) {
    return this.background.list(payload.activeOnly ?? false, payload.limit);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentRPCService,
  AgentRPCService,
  InstantiationType.Delayed,
  'rpc',
);
