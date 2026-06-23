import type {
  PermissionApprovalResultRecord,
  PermissionRule,
} from '../../../agent/permission';
import { Disposable, registerSingleton, SyncDescriptor } from '../../../di';

import { IEventBus } from '../eventBus/eventBus';
import { OrderedHookSlot } from '../hooks';
import { IWireRecord } from '../wireRecord/wireRecord';
import {
  IPermissionRulesService,
  type PermissionRulesServiceOptions,
} from './permissionRules';

declare module '../types' {
  interface WireRecordMap {
    'permission.rules.add': {
      rules: readonly PermissionRule[];
    };
    'permission.record_approval_result': PermissionApprovalResultRecord;
  }

  interface AgentEventMap {
    'permission.rules.changed': {
      rules: readonly PermissionRule[];
    };
    'permission.approval_recorded': {
      record: PermissionApprovalResultRecord;
    };
  }
}

export class PermissionRulesService extends Disposable implements IPermissionRulesService {
  private localRules: PermissionRule[];
  private readonly localSessionApprovalRulePatterns = new Set<string>();
  private readonly parent: IPermissionRulesService | undefined;

  readonly hooks = {
    onChanged: new OrderedHookSlot<{ rules: readonly PermissionRule[] }>(),
    onApprovalRecorded: new OrderedHookSlot<{ record: PermissionApprovalResultRecord }>(),
  };

  constructor(
    options: PermissionRulesServiceOptions = {},
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventBus private readonly events: IEventBus,
  ) {
    super();
    this.localRules = [...(options.initialRules ?? [])];
    this.parent = options.parent;
    this._register(
      wireRecord.register('permission.rules.add', (record) => {
        this.applyAddRules(record.rules);
      }),
    );
    this._register(
      wireRecord.register('permission.record_approval_result', (record) => {
        const { type: _type, time: _time, ...approval } = record;
        this.applyApprovalResult(approval);
      }),
    );
  }

  get rules(): readonly PermissionRule[] {
    return [...this.localRules, ...(this.parent?.rules ?? [])];
  }

  get sessionApprovalRulePatterns(): readonly string[] {
    return [
      ...this.localSessionApprovalRulePatterns,
      ...(this.parent?.sessionApprovalRulePatterns ?? []),
    ];
  }

  setInitialRules(rules: readonly PermissionRule[]): void {
    this.localRules = [...rules];
    this.emitRulesChanged();
  }

  addRules(rules: readonly PermissionRule[]): void {
    if (rules.length === 0) return;
    this.wireRecord.append({ type: 'permission.rules.add', rules: [...rules] });
    this.applyAddRules(rules);
  }

  recordApprovalResult(record: PermissionApprovalResultRecord): void {
    this.wireRecord.append({ type: 'permission.record_approval_result', ...record });
    this.applyApprovalResult(record);
  }

  private applyAddRules(rules: readonly PermissionRule[]): void {
    if (rules.length === 0) return;
    this.localRules.push(...rules);
    this.emitRulesChanged();
  }

  private applyApprovalResult(record: PermissionApprovalResultRecord): void {
    if (record.result.decision === 'approved' && record.result.scope === 'session') {
      const pattern = record.sessionApprovalRule;
      if (pattern !== undefined) {
        this.localSessionApprovalRulePatterns.add(pattern);
      }
    }
    this.events.emit({ type: 'permission.approval_recorded', record });
    void this.hooks.onApprovalRecorded.run({ record });
  }

  private emitRulesChanged(): void {
    const rules = this.rules;
    this.events.emit({ type: 'permission.rules.changed', rules });
    void this.hooks.onChanged.run({ rules });
  }
}

registerSingleton(
  IPermissionRulesService,
  new SyncDescriptor(PermissionRulesService, [{}], true),
);
