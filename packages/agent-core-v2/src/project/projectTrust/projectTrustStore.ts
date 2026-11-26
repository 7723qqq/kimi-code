import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { canonicalProjectRoot } from '#/_base/utils/paths';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import { WORKSPACE_TRUST_SECTION, workspaceTrustRequired } from './configSection';
import { trustWorkspaceEnvTrusted } from './trustEnv';
import { deleteProjectTrust, readProjectTrust, writeProjectTrust } from './trustRecord';
import { IProjectTrust, type WorkspaceTrustChange } from './projectTrust';

export interface IProjectTrustEntry extends IProjectTrust {
  isPersistedTrusted(): boolean;
  refresh(): Promise<boolean>;
}

export interface IProjectTrustStore {
  readonly _serviceBrand: undefined;

  forRoot(root: string): IProjectTrustEntry;
  forRoots(roots: readonly string[]): IProjectTrustEntry;
}

export const IProjectTrustStore: ServiceIdentifier<IProjectTrustStore> =
  createDecorator<IProjectTrustStore>('workspaceTrustStore');

class WorkspaceTrustEntry extends Disposable implements IProjectTrustEntry {
  declare readonly _serviceBrand: undefined;

  private initialization?: Promise<void>;
  private initializationFailed = false;
  private readonly root: string;
  private readonly envTrusted: boolean;
  private trusted = false;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly changeEmitter = this._register(new Emitter<WorkspaceTrustChange>());
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    root: string,
    private readonly docs: IAtomicDocumentStore,
    private readonly telemetry: ITelemetryService,
    bootstrap: IBootstrapService,
    private readonly config: IConfigService,
  ) {
    super();
    this.root = root;
    this.envTrusted = trustWorkspaceEnvTrusted((name) => bootstrap.getEnv(name));
  }

  get ready(): Promise<void> {
    if (this.initialization !== undefined) return this.initialization;
    const recovering = this.initializationFailed;
    const initialization = readProjectTrust(this.docs, this.root, this.telemetry).then(
      (trusted) => {
        this.trusted = trusted;
        this.initializationFailed = false;
        if (recovering) this.changeEmitter.fire({ trusted });
      },
    );
    this.initialization = initialization;
    void initialization.catch(() => {
      this.initializationFailed = true;
      if (this.initialization === initialization) this.initialization = undefined;
    });
    return initialization;
  }

  isPersistedTrusted(): boolean {
    return this.trusted;
  }

  isTrusted(): boolean {
    return !this.trustGateEnabled() || this.envTrusted || this.trusted;
  }

  async get(): Promise<boolean> {
    await this.ready;
    return this.isTrusted();
  }

  async refresh(): Promise<boolean> {
    const refresh = this.mutationTail
      .catch(() => {})
      .then(async () => {
        const trusted = await readProjectTrust(this.docs, this.root, this.telemetry);
        if (this.trusted === trusted) return;
        this.trusted = trusted;
        this.changeEmitter.fire({ trusted });
      });
    this.mutationTail = refresh;
    await refresh;
    return this.isTrusted();
  }

  onConfigChange(): void {
    if (!this.trustGateEnabled()) {
      this.changeEmitter.fire({ trusted: this.trusted });
      return;
    }
    void this.ready
      .catch(() => undefined)
      .then(() => this.changeEmitter.fire({ trusted: this.trusted }));
  }

  trust(): Promise<void> {
    return this.mutate(true);
  }

  untrust(): Promise<void> {
    return this.mutate(false);
  }

  private trustGateEnabled(): boolean {
    return workspaceTrustRequired(this.config);
  }

  private mutate(trusted: boolean): Promise<void> {
    const mutation = this.mutationTail
      .catch(() => {})
      .then(async () => {
        await this.ready;
        if (this.trusted === trusted) return;
        if (trusted) {
          await writeProjectTrust(this.docs, this.root, Date.now());
        } else {
          await deleteProjectTrust(this.docs, this.root);
        }
        this.trusted = trusted;
        this.changeEmitter.fire({ trusted });
        this.telemetry.track2('workspace_trust_changed', { trusted });
      });
    this.mutationTail = mutation;
    return mutation;
  }
}

class WorkspaceTrustGroup extends Disposable implements IProjectTrustEntry {
  declare readonly _serviceBrand: undefined;

  private readonly primary: IProjectTrustEntry;
  private readonly entries: readonly IProjectTrustEntry[];
  private readonly changeEmitter = this._register(new Emitter<WorkspaceTrustChange>());
  readonly onDidChange = this.changeEmitter.event;
  private initialization?: Promise<void>;

  constructor(
    roots: readonly string[],
    forRoot: (root: string) => IProjectTrustEntry,
  ) {
    super();
    const seen = new Set<string>();
    const entries: IProjectTrustEntry[] = [];
    for (const root of roots) {
      const key = canonicalProjectRoot(root);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = forRoot(root);
      entries.push(entry);
      this._register(entry.onDidChange(() => {
        this.changeEmitter.fire({ trusted: this.isPersistedTrusted() });
      }));
    }
    const primary = entries[0];
    if (primary === undefined) throw new Error('workspace trust requires a primary root');
    this.primary = primary;
    this.entries = entries;
  }

  get ready(): Promise<void> {
    if (this.initialization !== undefined) return this.initialization;
    const initialization = Promise.all(this.entries.map((entry) => entry.ready)).then(() => {});
    this.initialization = initialization;
    void initialization.catch(() => {
      if (this.initialization === initialization) this.initialization = undefined;
    });
    return initialization;
  }

  isPersistedTrusted(): boolean {
    return this.entries.some((entry) => entry.isPersistedTrusted());
  }

  isTrusted(): boolean {
    return this.entries.some((entry) => entry.isTrusted());
  }

  async get(): Promise<boolean> {
    return (await Promise.all(this.entries.map((entry) => entry.get()))).some(Boolean);
  }

  async refresh(): Promise<boolean> {
    await Promise.all(this.entries.map((entry) => entry.refresh()));
    return this.isTrusted();
  }

  trust(): Promise<void> {
    return this.primary.trust();
  }

  async untrust(): Promise<void> {
    await Promise.all(this.entries.map((entry) => entry.untrust()));
  }
}

export class WorkspaceTrustStore extends Disposable implements IProjectTrustStore {
  declare readonly _serviceBrand: undefined;

  private readonly entries = new Map<string, WorkspaceTrustEntry>();
  private readonly groups = new Map<string, WorkspaceTrustGroup>();

  constructor(
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain !== WORKSPACE_TRUST_SECTION) return;
        for (const entry of this.entries.values()) entry.onConfigChange();
      }),
    );
  }

  forRoot(root: string): IProjectTrustEntry {
    const key = canonicalProjectRoot(root);
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing;
    const entry = this._register(
      new WorkspaceTrustEntry(root, this.docs, this.telemetry, this.bootstrap, this.config),
    );
    this.entries.set(key, entry);
    return entry;
  }

  forRoots(roots: readonly string[]): IProjectTrustEntry {
    const primary = roots[0];
    if (primary === undefined) throw new Error('workspace trust requires a primary root');
    const key = [
      canonicalProjectRoot(primary),
      ...new Set(roots.map((root) => canonicalProjectRoot(root)).toSorted()),
    ].join('\0');
    const existing = this.groups.get(key);
    if (existing !== undefined) return existing;
    const group = this._register(new WorkspaceTrustGroup(roots, (root) => this.forRoot(root)));
    this.groups.set(key, group);
    return group;
  }
}

registerScopedService(
  LifecycleScope.App,
  IProjectTrustStore,
  WorkspaceTrustStore,
  ScopeActivation.OnDemand,
  'workspaceTrustStore',
);
