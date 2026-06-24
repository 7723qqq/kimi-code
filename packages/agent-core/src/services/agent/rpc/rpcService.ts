import { registerSingleton, SyncDescriptor } from '../../../di';
import { ErrorCodes, KimiError } from '../../../errors';
import { summarizeSkill } from '../../../skill';
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
  SessionAPI,
} from '../../../rpc/core-api';
import { IBackgroundService } from '../background/background';
import { IContextMemory } from '../contextMemory/contextMemory';
import { IContextUsageService } from '../contextUsage/contextUsage';
import { IFullCompaction } from '../fullCompaction/fullCompaction';
import { IPermissionService } from '../permission/permission';
import { IPermissionModeService } from '../permissionMode/permissionMode';
import { IPlanModeService } from '../planMode/planMode';
import { IProfileService } from '../profile/profile';
import { IPromptService } from '../prompt/prompt';
import { IAgentSkillService } from '../skill/skill';
import { ISubagentHost } from '../subagentHost/subagentHost';
import { ISwarmMode } from '../swarmMode/swarmMode';
import { ITelemetryService } from '../telemetry/telemetry';
import { IToolRegistry } from '../toolRegistry/toolRegistry';
import { ITurnRunner } from '../turnRunner/turnRunner';
import { IUsageService } from '../usage/usage';
import { IUserToolService } from '../userTool/userTool';
import {
  IAgentRPCService,
  ISessionRPCService,
} from './rpc';

export class AgentRPCService implements IAgentRPCService {
  constructor(
    @IPromptService private readonly promptService: IPromptService,
    @ITurnRunner private readonly turnRunner: ITurnRunner,
    @IProfileService private readonly profile: IProfileService,
    @IPermissionModeService private readonly permissionMode: IPermissionModeService,
    @IPermissionService private readonly permission: IPermissionService,
    @IPlanModeService private readonly planMode: IPlanModeService,
    @ISwarmMode private readonly swarmMode: ISwarmMode,
    @IFullCompaction private readonly fullCompaction: IFullCompaction,
    @IUserToolService private readonly userTools: IUserToolService,
    @IToolRegistry private readonly toolRegistry: IToolRegistry,
    @IBackgroundService private readonly background: IBackgroundService,
    @IContextMemory private readonly context: IContextMemory,
    @IContextUsageService private readonly contextUsage: IContextUsageService,
    @IAgentSkillService private readonly skills: IAgentSkillService,
    @ISubagentHost private readonly subagentHost: ISubagentHost,
    @IUsageService private readonly usage: IUsageService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  prompt(payload: PromptPayload): void {
    this.promptService.prompt({
      role: 'user',
      content: [...payload.input],
      toolCalls: [],
    });
  }

  steer(payload: SteerPayload): void {
    this.telemetry.track('input_steer', { parts: payload.input.length });
    this.promptService.steer({
      role: 'user',
      content: [...payload.input],
      toolCalls: [],
    });
  }

  cancel(payload: CancelPayload): void {
    if (this.turnRunner.getActiveTurn() !== undefined) {
      this.telemetry.track('cancel', { from: 'streaming' });
    }
    this.turnRunner.cancel(payload.turnId);
  }

  undoHistory(payload: UndoHistoryPayload): void {
    this.promptService.undo(payload.count);
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
    return this.swarmMode.data();
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
    const history = this.context.getHistory();
    if (history.length === 0) return;
    this.context.spliceHistory(0, history.length);
  }

  activateSkill(payload: ActivateSkillPayload): void {
    this.skills.activate(payload);
  }

  startBtw(_payload: EmptyPayload): Promise<string> {
    return this.subagentHost.startBtw();
  }

  createGoal(_payload: CreateGoalPayload) {
    return this.todo('createGoal');
  }

  getGoal(_payload: EmptyPayload) {
    return this.todo('getGoal');
  }

  pauseGoal(_payload: EmptyPayload) {
    return this.todo('pauseGoal');
  }

  resumeGoal(_payload: EmptyPayload) {
    return this.todo('resumeGoal');
  }

  cancelGoal(_payload: EmptyPayload) {
    return this.todo('cancelGoal');
  }

  getBackgroundOutput(payload: GetBackgroundOutputPayload): Promise<string> {
    return this.background.readOutput(payload.taskId, payload.tail);
  }

  getContext(_payload: EmptyPayload) {
    return {
      history: this.context.getHistory(),
      tokenCount: this.contextUsage.getStatus().contextTokens,
    };
  }

  getConfig(_payload: EmptyPayload) {
    return this.profile.data();
  }

  getPermission(_payload: EmptyPayload) {
    return this.permission.data();
  }

  getPlan(_payload: EmptyPayload) {
    return this.planMode.data();
  }

  getUsage(_payload: EmptyPayload) {
    return this.usage.data();
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

  private todo(method: string): never {
    throw new KimiError(
      ErrorCodes.NOT_IMPLEMENTED,
      `TODO: AgentRPCService.${method} is not migrated to services/agent.`,
    );
  }
}

type AgentScopedPayload<T extends keyof SessionAPI> = Parameters<SessionAPI[T]>[0];

export class SessionRPCService implements ISessionRPCService {
  constructor(
    @IAgentRPCService private readonly agent: IAgentRPCService,
    @IAgentSkillService private readonly skills: IAgentSkillService,
  ) {}

  renameSession(_payload: AgentScopedPayload<'renameSession'>): void {
    return this.todo('renameSession');
  }

  updateSessionMetadata(_payload: AgentScopedPayload<'updateSessionMetadata'>): void {
    return this.todo('updateSessionMetadata');
  }

  getSessionMetadata(_payload: AgentScopedPayload<'getSessionMetadata'>) {
    return this.todo('getSessionMetadata');
  }

  listSkills(_payload: AgentScopedPayload<'listSkills'>) {
    return this.skills.listSkills().map(summarizeSkill);
  }

  listMcpServers(_payload: AgentScopedPayload<'listMcpServers'>) {
    return this.todo('listMcpServers');
  }

  getMcpStartupMetrics(_payload: AgentScopedPayload<'getMcpStartupMetrics'>) {
    return this.todo('getMcpStartupMetrics');
  }

  reconnectMcpServer(_payload: AgentScopedPayload<'reconnectMcpServer'>): void {
    return this.todo('reconnectMcpServer');
  }

  generateAgentsMd(_payload: AgentScopedPayload<'generateAgentsMd'>): void {
    return this.todo('generateAgentsMd');
  }

  addAdditionalDir(_payload: AgentScopedPayload<'addAdditionalDir'>) {
    return this.todo('addAdditionalDir');
  }

  prompt({ agentId: _agentId, ...payload }: AgentScopedPayload<'prompt'>) {
    return this.agent.prompt(payload);
  }

  steer({ agentId: _agentId, ...payload }: AgentScopedPayload<'steer'>) {
    return this.agent.steer(payload);
  }

  cancel({ agentId: _agentId, ...payload }: AgentScopedPayload<'cancel'>) {
    return this.agent.cancel(payload);
  }

  undoHistory({ agentId: _agentId, ...payload }: AgentScopedPayload<'undoHistory'>) {
    return this.agent.undoHistory(payload);
  }

  setThinking({ agentId: _agentId, ...payload }: AgentScopedPayload<'setThinking'>) {
    return this.agent.setThinking(payload);
  }

  setPermission({ agentId: _agentId, ...payload }: AgentScopedPayload<'setPermission'>) {
    return this.agent.setPermission(payload);
  }

  setModel({ agentId: _agentId, ...payload }: AgentScopedPayload<'setModel'>) {
    return this.agent.setModel(payload);
  }

  getModel({ agentId: _agentId, ...payload }: AgentScopedPayload<'getModel'>) {
    return this.agent.getModel(payload);
  }

  enterPlan({ agentId: _agentId, ...payload }: AgentScopedPayload<'enterPlan'>) {
    return this.agent.enterPlan(payload);
  }

  cancelPlan({ agentId: _agentId, ...payload }: AgentScopedPayload<'cancelPlan'>) {
    return this.agent.cancelPlan(payload);
  }

  clearPlan({ agentId: _agentId, ...payload }: AgentScopedPayload<'clearPlan'>) {
    return this.agent.clearPlan(payload);
  }

  enterSwarm({ agentId: _agentId, ...payload }: AgentScopedPayload<'enterSwarm'>) {
    return this.agent.enterSwarm(payload);
  }

  exitSwarm({ agentId: _agentId, ...payload }: AgentScopedPayload<'exitSwarm'>) {
    return this.agent.exitSwarm(payload);
  }

  getSwarmMode({ agentId: _agentId, ...payload }: AgentScopedPayload<'getSwarmMode'>) {
    return this.agent.getSwarmMode(payload);
  }

  beginCompaction({ agentId: _agentId, ...payload }: AgentScopedPayload<'beginCompaction'>) {
    return this.agent.beginCompaction(payload);
  }

  cancelCompaction({ agentId: _agentId, ...payload }: AgentScopedPayload<'cancelCompaction'>) {
    return this.agent.cancelCompaction(payload);
  }

  registerTool({ agentId: _agentId, ...payload }: AgentScopedPayload<'registerTool'>) {
    return this.agent.registerTool(payload);
  }

  unregisterTool({ agentId: _agentId, ...payload }: AgentScopedPayload<'unregisterTool'>) {
    return this.agent.unregisterTool(payload);
  }

  setActiveTools({ agentId: _agentId, ...payload }: AgentScopedPayload<'setActiveTools'>) {
    return this.agent.setActiveTools(payload);
  }

  stopBackground({ agentId: _agentId, ...payload }: AgentScopedPayload<'stopBackground'>) {
    return this.agent.stopBackground(payload);
  }

  detachBackground({ agentId: _agentId, ...payload }: AgentScopedPayload<'detachBackground'>) {
    return this.agent.detachBackground(payload);
  }

  clearContext({ agentId: _agentId, ...payload }: AgentScopedPayload<'clearContext'>) {
    return this.agent.clearContext(payload);
  }

  activateSkill({ agentId: _agentId, ...payload }: AgentScopedPayload<'activateSkill'>) {
    return this.agent.activateSkill(payload);
  }

  startBtw({ agentId: _agentId, ...payload }: AgentScopedPayload<'startBtw'>) {
    return this.agent.startBtw(payload);
  }

  createGoal({ agentId: _agentId, ...payload }: AgentScopedPayload<'createGoal'>) {
    return this.agent.createGoal(payload);
  }

  getGoal({ agentId: _agentId, ...payload }: AgentScopedPayload<'getGoal'>) {
    return this.agent.getGoal(payload);
  }

  pauseGoal({ agentId: _agentId, ...payload }: AgentScopedPayload<'pauseGoal'>) {
    return this.agent.pauseGoal(payload);
  }

  resumeGoal({ agentId: _agentId, ...payload }: AgentScopedPayload<'resumeGoal'>) {
    return this.agent.resumeGoal(payload);
  }

  cancelGoal({ agentId: _agentId, ...payload }: AgentScopedPayload<'cancelGoal'>) {
    return this.agent.cancelGoal(payload);
  }

  getBackgroundOutput({ agentId: _agentId, ...payload }: AgentScopedPayload<'getBackgroundOutput'>) {
    return this.agent.getBackgroundOutput(payload);
  }

  getContext({ agentId: _agentId, ...payload }: AgentScopedPayload<'getContext'>) {
    return this.agent.getContext(payload);
  }

  getConfig({ agentId: _agentId, ...payload }: AgentScopedPayload<'getConfig'>) {
    return this.agent.getConfig(payload);
  }

  getPermission({ agentId: _agentId, ...payload }: AgentScopedPayload<'getPermission'>) {
    return this.agent.getPermission(payload);
  }

  getPlan({ agentId: _agentId, ...payload }: AgentScopedPayload<'getPlan'>) {
    return this.agent.getPlan(payload);
  }

  getUsage({ agentId: _agentId, ...payload }: AgentScopedPayload<'getUsage'>) {
    return this.agent.getUsage(payload);
  }

  getTools({ agentId: _agentId, ...payload }: AgentScopedPayload<'getTools'>) {
    return this.agent.getTools(payload);
  }

  getBackground({ agentId: _agentId, ...payload }: AgentScopedPayload<'getBackground'>) {
    return this.agent.getBackground(payload);
  }

  private todo(method: string): never {
    throw new KimiError(
      ErrorCodes.NOT_IMPLEMENTED,
      `TODO: SessionRPCService.${method} is not migrated to services/agent.`,
    );
  }
}

registerSingleton(
  IAgentRPCService,
  new SyncDescriptor(AgentRPCService, [], true),
);

registerSingleton(
  ISessionRPCService,
  new SyncDescriptor(SessionRPCService, [], true),
);
