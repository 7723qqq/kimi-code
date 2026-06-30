import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBackgroundService } from '#/background';
import { IContextMemory } from '#/contextMemory';
import { IContextSizeService } from '#/contextSize';
import { IFileToolsService } from '#/fileTools';
import { IFullCompaction } from '#/fullCompaction';
import { IGoalService } from '#/goal';
import { IPermissionGate } from '#/permission/permission';
import { IPermissionModeService } from '#/permissionMode/permissionMode';
import { IPlanService } from '../plan';
import { IProfileService } from '#/profile';
import { IPromptService } from '#/prompt';
import { IShellToolsService } from '#/shellTools';
import { IAgentSkillService } from '#/skill';
import { ISubagentHost } from '#/subagentHost';
import { ISwarmService } from '../swarm';
import { ITelemetryService } from '#/telemetry';
import { IToolRegistry } from '#/toolRegistry';
import { ITurnService } from '../turn';
import { IUsageService } from '#/usage';
import { IUserToolService } from '#/userTool';
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
    @IPromptService private readonly promptService: IPromptService,
    @ITurnService private readonly turnService: ITurnService,
    @IProfileService private readonly profile: IProfileService,
    @IPermissionModeService private readonly permissionMode: IPermissionModeService,
    @IPermissionGate private readonly permission: IPermissionGate,
    @IPlanService private readonly planMode: IPlanService,
    @ISwarmService private readonly swarmMode: ISwarmService,
    @IFullCompaction private readonly fullCompaction: IFullCompaction,
    @IUserToolService private readonly userTools: IUserToolService,
    @IToolRegistry private readonly toolRegistry: IToolRegistry,
    @IFileToolsService private readonly fileTools: IFileToolsService,
    @IShellToolsService private readonly shellTools: IShellToolsService,
    @IBackgroundService private readonly background: IBackgroundService,
    @IContextMemory private readonly context: IContextMemory,
    @IContextSizeService private readonly contextSize: IContextSizeService,
    @IAgentSkillService private readonly skills: IAgentSkillService,
    @ISubagentHost private readonly subagentHost: ISubagentHost,
    @IUsageService private readonly usage: IUsageService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IGoalService private readonly goal: IGoalService,
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
    turn.abortController.abort();
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
