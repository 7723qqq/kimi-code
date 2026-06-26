/**
 * `config` domain (L2) — `IConfigRegistry` and `IConfigService` implementations.
 *
 * Owns the section registry and the global config file state; reads config
 * paths through `environment` and logs through `log`. Bound at Core scope.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'pathe';

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { atomicWrite } from '#/_base/utils/fs';
import { IEnvironmentService } from '#/environment';
import { ILogService } from '#/log';

import {
  type ConfigChangedEvent,
  type ConfigDiagnostic,
  type ConfigMerge,
  type ConfigSchema,
  type ConfigSection,
  type ConfigSectionRegisteredEvent,
  type ConfigChangeSource,
  type RegisterSectionOptions,
  type ResolvedConfig,
  IConfigRegistry,
  IConfigService,
} from './config';
import { deepMerge, describeUnknownError, isPlainObject } from './configPure';
import { applyEnvModelOverlay, stripEnvForDomain } from './env-model';
import {
  applySectionToToml,
  cloneRecord,
  describeTomlSyntaxError,
  transformTomlData,
} from './toml';

export class ConfigRegistry implements IConfigRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly sections = new Map<string, ConfigSection>();
  private readonly _onDidRegisterSection = new Emitter<ConfigSectionRegisteredEvent>();
  readonly onDidRegisterSection: Event<ConfigSectionRegisteredEvent> = this._onDidRegisterSection.event;

  registerSection<T>(
    domain: string,
    schema: ConfigSchema<T>,
    options: RegisterSectionOptions<T> = {},
  ): void {
    if (this.sections.has(domain)) {
      throw new Error(`ConfigRegistry: section '${domain}' is already registered`);
    }
    this.sections.set(domain, {
      domain,
      schema: schema as ConfigSchema<unknown>,
      defaultValue: options.defaultValue,
      merge: (options.merge ?? deepMerge) as ConfigMerge<unknown>,
    });
    this._onDidRegisterSection.fire({ domain });
  }

  getSection(domain: string): ConfigSection | undefined {
    return this.sections.get(domain);
  }

  listSections(): readonly ConfigSection[] {
    return [...this.sections.values()];
  }

  validate<T>(domain: string, value: unknown): T {
    const schema = this.sections.get(domain)?.schema;
    return (schema === undefined ? value : schema.parse(value)) as T;
  }

  merge<T>(domain: string, base: T | undefined, patch: unknown): T {
    const merge = this.sections.get(domain)?.merge ?? deepMerge;
    return merge(base, patch) as T;
  }

  defaultValue<T>(domain: string): T | undefined {
    return this.sections.get(domain)?.defaultValue as T | undefined;
  }
}

export class ConfigService extends Disposable implements IConfigService {
  declare readonly _serviceBrand: undefined;
  private readonly _onDidChange = this._register(new Emitter<ConfigChangedEvent>());
  readonly onDidChange: Event<ConfigChangedEvent> = this._onDidChange.event;
  readonly ready = Promise.resolve();

  /** Snake_case clone of the file; the write base, kept for round-trip. */
  private rawSnake: ResolvedConfig = {};
  /** CamelCase, env-free in-memory values (post read-transform). */
  private raw: ResolvedConfig = {};
  /** Validated effective values with the env overlay applied. */
  private effective: ResolvedConfig = {};
  private readonly diagnosticsList: ConfigDiagnostic[] = [];

  constructor(
    @IConfigRegistry private readonly registry: IConfigRegistry,
    @IEnvironmentService private readonly env: IEnvironmentService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(this.registry.onDidRegisterSection((e) => this.revalidateDomain(e.domain)));
    this.loadSync('load');
  }

  get<T = unknown>(domain: string): T {
    return this.effective[domain] as T;
  }

  getAll(): ResolvedConfig {
    return { ...this.effective };
  }

  diagnostics(): readonly ConfigDiagnostic[] {
    return [...this.diagnosticsList];
  }

  async set(domain: string, patch: unknown): Promise<void> {
    const base = this.raw[domain];
    const next = this.registry.merge(domain, base, patch);
    const validated = this.registry.validate(domain, next);
    this.raw[domain] = validated;
    await this.persist(domain);
    this.rebuildEffective('set', [domain]);
  }

  async replace(domain: string, value: unknown): Promise<void> {
    const stripped = stripEnvForDomain(domain, value, this.rawSnake);
    if (stripped === undefined) {
      delete this.raw[domain];
    } else {
      this.raw[domain] = this.registry.validate(domain, stripped);
    }
    await this.persist(domain);
    this.rebuildEffective('set', [domain]);
  }

  reload(): Promise<void> {
    this.loadSync('reload');
    return Promise.resolve();
  }

  private loadSync(source: ConfigChangeSource): void {
    this.diagnosticsList.length = 0;
    let fileData: ResolvedConfig = {};
    try {
      fileData = this.readFileData();
    } catch (error) {
      this.diagnosticsList.push({
        severity: 'error',
        message: describeUnknownError(error),
      });
      this.log.warn('config load failed', { error: describeUnknownError(error) });
    }
    this.rawSnake = cloneRecord(fileData);
    this.raw = transformTomlData(fileData);
    this.rebuildEffective(source);
  }

  private readFileData(): ResolvedConfig {
    if (!existsSync(this.env.configPath)) {
      return {};
    }
    const text = readFileSync(this.env.configPath, 'utf-8');
    if (text.trim().length === 0) {
      return {};
    }
    try {
      const parsed = parseToml(text);
      return isPlainObject(parsed) ? parsed : {};
    } catch (error) {
      throw new Error(
        `Failed to parse ${this.env.configPath}: ${describeTomlSyntaxError(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Recompute `effective` from `raw`: validate each present domain (dropping
   * invalid ones into diagnostics), fill registered defaults, then apply the
   * `KIMI_MODEL_*` env overlay (surfacing problems as env warnings).
   */
  private rebuildEffective(source: ConfigChangeSource = 'reload', domains?: readonly string[]): void {
    const previous = this.effective;
    const next = this.buildEffective(this.raw);
    this.applyEnvOverlay(next);
    this.effective = next;

    const changedDomains =
      domains ?? [...new Set([...Object.keys(previous), ...Object.keys(next)])];
    for (const domain of changedDomains) {
      this._onDidChange.fire({ domain, source });
    }
  }

  private buildEffective(raw: ResolvedConfig): ResolvedConfig {
    const effective: ResolvedConfig = {};
    for (const [domain, value] of Object.entries(raw)) {
      try {
        effective[domain] = this.registry.validate(domain, value);
      } catch (error) {
        this.diagnosticsList.push({
          domain,
          severity: 'warning',
          message: `Ignored invalid config section '${domain}': ${describeUnknownError(error)}`,
        });
      }
    }
    for (const section of this.registry.listSections()) {
      if (effective[section.domain] === undefined && section.defaultValue !== undefined) {
        effective[section.domain] = section.defaultValue;
      }
    }
    return effective;
  }

  private applyEnvOverlay(effective: ResolvedConfig): void {
    try {
      applyEnvModelOverlay(effective, process.env, (domain, value) =>
        this.registry.validate(domain, value),
      );
    } catch (error) {
      this.diagnosticsList.push({
        severity: 'warning',
        message: `Ignoring KIMI_MODEL_* environment overrides: ${describeUnknownError(error)}`,
      });
    }
  }

  /**
   * Re-validate a single domain when its section is registered (possibly after
   * the initial load). Applies the freshly registered schema / default to the
   * already-loaded raw value, re-runs the env overlay (which may depend on this
   * domain), and fires `onDidChange` if the effective value changed. This keeps
   * validation and defaults correct under lazy, out-of-order registration.
   */
  private revalidateDomain(domain: string): void {
    const section = this.registry.getSection(domain);
    if (section === undefined) return;

    const before = JSON.stringify(this.effective[domain]);
    if (this.raw[domain] !== undefined) {
      try {
        this.effective[domain] = this.registry.validate(domain, this.raw[domain]);
      } catch {
        // Invalid value was already reported as a diagnostic at load time.
        return;
      }
    } else if (section.defaultValue !== undefined && this.effective[domain] === undefined) {
      this.effective[domain] = section.defaultValue;
    } else {
      return;
    }

    this.applyEnvOverlay(this.effective);
    if (JSON.stringify(this.effective[domain]) !== before) {
      this._onDidChange.fire({ domain, source: 'reload' });
    }
  }

  private async persist(domain: string): Promise<void> {
    applySectionToToml(this.rawSnake, domain, this.raw[domain]);
    await mkdir(dirname(this.env.configPath), { recursive: true, mode: 0o700 });
    await atomicWrite(this.env.configPath, `${stringifyToml(this.rawSnake)}\n`);
  }
}

registerScopedService(LifecycleScope.Core, IConfigRegistry, ConfigRegistry, InstantiationType.Delayed, 'config');
registerScopedService(LifecycleScope.Core, IConfigService, ConfigService, InstantiationType.Delayed, 'config');
