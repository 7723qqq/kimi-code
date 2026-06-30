/**
 * `model` domain (L2) — `IModelService` implementation.
 *
 * Owns the in-memory view of the `models` config section, persists changes
 * through `config`, registers the section schema plus the `KIMI_MODEL_*`
 * effective overlay on construction, and forwards section changes as
 * `onDidChange`. Bound at App scope, eager — registering the `models` section
 * is an early side effect that config reads depend on.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { IConfigRegistry, IConfigService } from '#/config/config';

import { modelsFromToml, modelsToToml } from './configSection';
import { kimiModelEnvOverlay } from './envOverlay';
import {
  type ModelAlias,
  type ModelsSection,
  IModelService,
  MODELS_SECTION,
  ModelsSectionSchema,
} from './model';

export class ModelService extends Disposable implements IModelService {
  declare readonly _serviceBrand: undefined;
  private readonly _onDidChange = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this._onDidChange.event;

  constructor(
    @IConfigRegistry registry: IConfigRegistry,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
    registry.registerSection(MODELS_SECTION, ModelsSectionSchema, {
      defaultValue: {},
      fromToml: modelsFromToml,
      toToml: modelsToToml,
    });
    registry.registerEffectiveOverlay(kimiModelEnvOverlay);
    this._register(
      config.onDidChange((e) => {
        if (e.domain === MODELS_SECTION) {
          this._onDidChange.fire();
        }
      }),
    );
  }

  get(alias: string): ModelAlias | undefined {
    return this.config.get<ModelsSection>(MODELS_SECTION)?.[alias];
  }

  list(): Readonly<Record<string, ModelAlias>> {
    return this.config.get<ModelsSection>(MODELS_SECTION) ?? {};
  }

  async set(alias: string, model: ModelAlias): Promise<void> {
    await this.config.set(MODELS_SECTION, { [alias]: model });
  }

  async delete(alias: string): Promise<void> {
    const current = this.config.get<ModelsSection>(MODELS_SECTION) ?? {};
    if (!(alias in current)) return;
    const { [alias]: _removed, ...rest } = current;
    await this.config.replace(MODELS_SECTION, rest);
  }
}

registerScopedService(LifecycleScope.App, IModelService, ModelService, InstantiationType.Eager, 'model');
