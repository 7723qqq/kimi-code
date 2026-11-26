import { Disposable } from '#/_base/di/lifecycle';
import { IConfigService } from '#/app/config/config';
import {
  hiddenFromModelPatterns,
  isHiddenFromModel,
  SKILLS_SECTION,
  subSkillPatterns,
} from '#/features/skill/catalog/configSection';
import { Emitter, type Event } from '#/_base/event';
import { IBuiltinSkillSource } from '#/features/skill/catalog/builtinSkillSource';
import { InMemorySkillCatalog } from '#/features/skill/catalog/registry';
import type { ISkillSource, SkillContribution } from '#/features/skill/catalog/skillSource';
import type { SkillCatalog } from '#/features/skill/catalog/types';
import { IUserFileSkillSource } from '#/features/skill/catalog/userFileSkillSource';
import type { ISessionSkillCatalogData } from '#/features/skill/session/skillCatalogData';
import { defineState } from '#/state/state';
import { IWorkspaceStateService } from '#/project/state/projectState';

import { IExplicitFileSkillSource } from './explicitFileSkillSource';
import { IExtraFileSkillSource } from './extraFileSkillSource';
import { IPluginSkillSource } from './pluginSkillSource';
import { IWorkspaceRootSkillSource } from './rootFileSkillSource';
import { IWorkspaceSkillCatalog } from './projectSkillCatalog';

export const workspaceSkillCatalogContributionsKey = defineState<
  Map<string, { readonly c: SkillContribution; readonly priority: number }>
>('workspaceSkillCatalog.contributions', () => new Map());
export const workspaceSkillCatalogMergedKey = defineState<InMemorySkillCatalog>(
  'workspaceSkillCatalog.merged',
  () => new InMemorySkillCatalog(),
);

export class WorkspaceSkillCatalogService extends Disposable implements IWorkspaceSkillCatalog {
  declare readonly _serviceBrand: undefined;

  private readonly sources: readonly ISkillSource[];
  private readonly sourceLoadTails = new Map<ISkillSource, Promise<void>>();
  readonly ready: Promise<void>;
  private readonly onDidChangeEmitter = this._register(new Emitter<string>());
  readonly onDidChange: Event<string> = this.onDidChangeEmitter.event;

  constructor(
    @IBuiltinSkillSource builtin: IBuiltinSkillSource,
    @IUserFileSkillSource user: IUserFileSkillSource,
    @IExplicitFileSkillSource explicit: IExplicitFileSkillSource,
    @IExtraFileSkillSource extra: IExtraFileSkillSource,
    @IWorkspaceRootSkillSource workspace: IWorkspaceRootSkillSource,
    @IPluginSkillSource plugin: IPluginSkillSource,
    @IWorkspaceStateService private readonly states: IWorkspaceStateService,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
    this.states.contributeState(workspaceSkillCatalogContributionsKey);
    this.states.contributeState(workspaceSkillCatalogMergedKey);
    this.sources = [builtin, user, explicit, extra, workspace, plugin].toSorted(
      (a, b) => a.priority - b.priority,
    );
    for (const s of this.sources) {
      if (s.onDidChange)
        this._register(
          s.onDidChange(() => {
            void this.reloadSource(s.id);
          }),
        );
    }
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain !== SKILLS_SECTION) return;
        this.remerge();
        this.onDidChangeEmitter.fire('catalog');
      }),
    );
    this.ready = this.loadAll();
    void this.ready.catch(() => undefined);
  }

  private get contributions(): Map<
    string,
    { readonly c: SkillContribution; readonly priority: number }
  > {
    return this.states.get(workspaceSkillCatalogContributionsKey);
  }

  private get merged(): InMemorySkillCatalog {
    return this.states.get(workspaceSkillCatalogMergedKey);
  }

  private set merged(value: InMemorySkillCatalog) {
    this.states.set(workspaceSkillCatalogMergedKey, value);
  }

  get catalog(): SkillCatalog {
    return this.merged;
  }

  async reload(): Promise<void> {
    await this.loadAll();
    this.onDidChangeEmitter.fire('catalog');
  }

  async reloadSources(ids: readonly string[]): Promise<void> {
    await Promise.all(ids.map((id) => this.reloadSource(id)));
  }

  async load(): Promise<void> {
    await this.ready;
  }

  sessionData(): ISessionSkillCatalogData {
    const currentCatalog = (): SkillCatalog => this.merged;
    return {
      _serviceBrand: undefined,
      ready: this.ready,
      onDidChange: this.onDidChange,
      get catalog() {
        return currentCatalog();
      },
    };
  }

  private async loadAll(): Promise<void> {
    for (const s of this.sources) {
      await this.loadSource(s);
    }
    this.remerge();
  }

  private async reloadSource(id: string): Promise<void> {
    const s = this.sources.find((x) => x.id === id);
    if (!s) return;
    await this.loadSource(s, true);
  }

  private loadSource(source: ISkillSource, fireChange = false): Promise<void> {
    const previous = this.sourceLoadTails.get(source) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const contribution = await source.load();
        this.contributions.set(source.id, { c: contribution, priority: source.priority });
        if (fireChange) {
          this.remerge();
          this.onDidChangeEmitter.fire(source.id);
        }
      });
    this.sourceLoadTails.set(source, current);
    const clear = () => {
      if (this.sourceLoadTails.get(source) === current) {
        this.sourceLoadTails.delete(source);
      }
    };
    void current.then(clear, clear);
    return current;
  }

  private remerge(): void {
    const m = new InMemorySkillCatalog();
    const hidden = hiddenFromModelPatterns(this.config);
    const bundled = subSkillPatterns(this.config);
    const apply = <T extends SkillContribution['skills'][number]>(skill: T): T =>
      bundledOf(visibilityOf(skill, hidden), bundled);
    const ordered = [...this.contributions.values()].toSorted((a, b) => a.priority - b.priority);
    for (const { c } of ordered) {
      for (const skill of c.skills) {
        m.register(apply(skill), { replace: true });
      }
      m.registerVariants((c.variants ?? c.skills).map(apply), { replace: true });
      m.addRoots(c.scannedRoots ?? []);
      m.recordSkipped(c.skipped ?? []);
    }
    this.merged = m;
  }
}

function visibilityOf<T extends SkillContribution['skills'][number]>(
  skill: T,
  hidden: readonly string[],
): T {
  if (hidden.length === 0 || skill.metadata.disableModelInvocation === true) return skill;
  if (!isHiddenFromModel(skill.name, hidden)) return skill;
  return { ...skill, metadata: { ...skill.metadata, disableModelInvocation: true } };
}

function bundledOf<T extends SkillContribution['skills'][number]>(
  skill: T,
  bundled: readonly string[],
): T {
  if (bundled.length === 0 || skill.metadata.isSubSkill === true) return skill;
  if (!isHiddenFromModel(skill.name, bundled)) return skill;
  return { ...skill, metadata: { ...skill.metadata, isSubSkill: true } };
}
