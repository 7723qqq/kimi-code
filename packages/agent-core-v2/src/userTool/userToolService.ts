import {
  Disposable,
  type IDisposable,
} from "#/_base/di";
import type {
  ExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
} from '#/tool';
import { IAgentProfileService } from '#/profile';
import { IAgentToolRegistryService } from '#/toolRegistry';
import type { ToolResult } from '#/tool';
import { IAgentWireRecordService } from '#/wireRecord';
import {
  IAgentUserToolService,
  type UserToolRegistration,
} from './userTool';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

declare module '#/wireRecord' {
  interface WireRecordMap {
    'tools.register_user_tool': UserToolRegistration;
    'tools.unregister_user_tool': {
      readonly name: string;
    };
  }
}

export class AgentUserToolService extends Disposable implements IAgentUserToolService {
  declare readonly _serviceBrand: undefined;

  private readonly registrations = new Map<string, IDisposable>();

  constructor(
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentWireRecordService private readonly wireRecord: IAgentWireRecordService,
  ) {
    super();
    this._register(
      wireRecord.register('tools.register_user_tool', (record) => {
        this.applyRegister(record);
      }),
    );
    this._register(
      wireRecord.register('tools.unregister_user_tool', (record) => {
        this.applyUnregister(record.name);
      }),
    );
  }

  register(input: UserToolRegistration): void {
    this.wireRecord.append({ type: 'tools.register_user_tool', ...input });
    this.applyRegister(input);
  }

  unregister(name: string): void {
    this.wireRecord.append({ type: 'tools.unregister_user_tool', name });
    this.applyUnregister(name);
  }

  private applyRegister(input: UserToolRegistration): void {
    const { name, description, parameters } = input;
    this.applyUnregister(name);
    const tool: ExecutableTool = {
      name,
      description,
      parameters,
      resolveExecution: (args) => ({
        approvalRule: name,
        execute: async (context) =>
          toExecutableToolResult(await this.executeUserTool(context, name, args)),
      }),
    };
    this.registrations.set(name, this._register(this.registry.register(tool, { source: 'user' })));
    this.profile.addActiveTool(name);
  }

  private applyUnregister(name: string): void {
    const registration = this.registrations.get(name);
    if (registration === undefined) return;
    registration.dispose();
    this.registrations.delete(name);
    this.profile.removeActiveTool(name);
  }

  private async executeUserTool(
    _context: ExecutableToolContext,
    _name: string,
    _args: unknown,
  ): Promise<ToolResult> {
    throw new Error('TODO');
  }
}

function toExecutableToolResult(result: ToolResult): ExecutableToolResult {
  if (result.isError === true) {
    return {
      output: result.output,
      isError: true,
      message: result.message,
      stopTurn: result.stopTurn,
    };
  }
  return {
    output: result.output,
    message: result.message,
    stopTurn: result.stopTurn,
  };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentUserToolService,
  AgentUserToolService,
  InstantiationType.Eager,
  'userTool',
);
