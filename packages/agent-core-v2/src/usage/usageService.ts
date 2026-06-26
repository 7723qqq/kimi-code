import {
  addUsage,
  type TokenUsage } from '@moonshot-ai/kosong';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Disposable } from '#/_base/di/lifecycle';

import { IEventSink } from '../eventSink';
import type { UsageRecordScope, UsageStatus } from './usage';
import { IUsageService } from './usage';
import { IWireRecord } from '#/wireRecord';
import { ITurnService } from '#/turn';

declare module '#/wireRecord' {
  interface WireRecordMap {
    'usage.record': {
      model: string;
      usage: TokenUsage;
      usageScope?: UsageRecordScope;
    };
  }
}

export class UsageService extends Disposable implements IUsageService {
  private readonly byModel: Record<string, TokenUsage> = {};
  private currentTurn: TokenUsage | undefined;

  constructor(
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventSink private readonly events: IEventSink,
    @ITurnService private readonly turnService: ITurnService,
  ) {
    super();
    this._register(
      wireRecord.register('usage.record', (record) => {
        this.apply(record.model, record.usage, 'session');
      }),
    );
    this._register(
      turnService.hooks.onLaunched.register('usage-reset-current-turn', (_, next) => {
        this.currentTurn = undefined;
        return next();
      }),
    );
    this._register(
      turnService.hooks.onEnded.register('usage-reset-current-turn', (_, next) => {
        this.currentTurn = undefined;
        return next();
      }),
    );
  }

  record(model: string, usage: TokenUsage, scope: UsageRecordScope = 'session'): void {
    this.wireRecord.append({
      type: 'usage.record',
      model,
      usage,
      usageScope: scope,
    });
    this.apply(model, usage, scope);
    this.publishChanged();
  }

  data(): UsageStatus {
    const byModel = this.byModelSnapshot();
    const hasByModel = Object.keys(byModel).length > 0;
    const currentTurn = this.currentTurn;
    return {
      byModel: hasByModel ? byModel : undefined,
      total: hasByModel ? totalUsage(byModel) : undefined,
      currentTurn: currentTurn === undefined ? undefined : copyUsage(currentTurn),
    };
  }

  status(): UsageStatus | undefined {
    const status = this.data();
    if (
      status.byModel === undefined &&
      status.total === undefined &&
      status.currentTurn === undefined
    ) {
      return undefined;
    }
    return status;
  }

  private apply(model: string, usage: TokenUsage, scope: UsageRecordScope): void {
    const current = this.byModel[model];
    this.byModel[model] = current === undefined ? copyUsage(usage) : addUsage(current, usage);

    if (scope === 'turn') {
      this.currentTurn =
        this.currentTurn === undefined ? copyUsage(usage) : addUsage(this.currentTurn, usage);
    }
  }

  private publishChanged(): void {
    const status = this.status();
    if (status === undefined) return;
    this.events.emit({ type: 'agent.status.updated', usage: status });
  }

  private byModelSnapshot(): Record<string, TokenUsage> {
    return Object.fromEntries(
      Object.entries(this.byModel).map(([model, usage]) => [model, copyUsage(usage)]),
    );
  }
}

function copyUsage(usage: TokenUsage): TokenUsage {
  return { ...usage };
}

function totalUsage(byModel: Record<string, TokenUsage>): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const usage of Object.values(byModel)) {
    total = total === undefined ? copyUsage(usage) : addUsage(total, usage);
  }
  return total;
}

registerScopedService(
  LifecycleScope.Agent,
  IUsageService,
  UsageService,
  InstantiationType.Delayed,
  'usage',
);
