import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  apiKeyEnvMissingMessage,
  fetchCompleteFeedbackUpload,
  fetchCreateFeedbackUploadUrl,
  fetchSubmitFeedback,
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeFeedbackUrl,
  resolveKimiCodeRuntimeAuth,
  type SubmitFeedbackBody,
} from '@moonshot-ai/kimi-code-oauth';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IOAuthService } from '#/app/auth/auth';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import {
  ISessionExportService,
  type ExportSessionPreview,
} from '#/app/sessionExport/sessionExport';
import { LifecycleScope } from '#/app/scopes';
import { IModelService, type ModelRecord } from '#/llm-adapter/model/model';
import {
  nonEmpty,
  resolveActiveModelProvider,
  resolveModelAuthMaterial,
} from '#/llm-adapter/model/model-auth';
import type { ResolvedModelAuthMaterial } from '#/llm-adapter/model/model.types';
import { IProviderService, type ProviderConfig } from '#/llm-adapter/provider/provider';

import {
  IFeedbackService,
  type FeedbackAttachmentLevel,
  type FeedbackAvailability,
  type FeedbackSessionPreview,
  type FeedbackSubmitInput,
  type FeedbackSubmitResult,
} from './feedback';
import { createFeedbackArchivePath, type FeedbackArchive } from './feedback/archive';
import {
  packageCodebase,
  scanCodebase,
  type FeedbackCodebaseLimitExceeded,
  type FeedbackCodebaseScanResult,
} from './feedback/codebase/index';
import { MAX_ARCHIVE_SIZE, uploadArchive, type FeedbackUploadUrlApi } from './feedback/upload';

export const CODEBASE_ARCHIVE_FILENAME = 'repo.zip';
export const SESSION_ARCHIVE_FILENAME = 'session.zip';

const CODEBASE_SCAN_TIMEOUT_MS = 3000;

type FeedbackTarget =
  | {
      readonly kind: 'custom';
      readonly url: string;
      readonly token: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'managed'; readonly baseUrl?: string; readonly token: string }
  | { readonly kind: 'needs-login' }
  | { readonly kind: 'error'; readonly message: string };

interface AttachmentOutcome {
  readonly failed: boolean;
  readonly codebaseTruncated?: FeedbackCodebaseLimitExceeded;
}

export class FeedbackService implements IFeedbackService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IProviderService private readonly providers: IProviderService,
    @IModelService private readonly models: IModelService,
    @IConfigService private readonly config: IConfigService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IBootstrapService private readonly bootstrap?: IBootstrapService,
    @ISessionExportService private readonly sessionExport?: ISessionExportService,
    @ILogService private readonly log?: ILogService,
  ) {}

  async availability(modelAlias?: string, sessionId?: string): Promise<FeedbackAvailability> {
    const target = await this.resolveTarget(modelAlias, false);
    if (target.kind !== 'custom' && target.kind !== 'managed') return target;
    const preview = await this.previewSession(sessionId);
    if (preview === undefined) return { kind: 'ready' };
    const session: FeedbackSessionPreview = {
      sessionId: preview.sessionId,
      sessionDir: preview.sessionDir,
      files: preview.files,
    };
    return { kind: 'ready', session };
  }

  async submit(input: FeedbackSubmitInput, modelAlias?: string): Promise<FeedbackSubmitResult> {
    const effectiveModelAlias = modelAlias ?? input.model ?? undefined;
    const target = await this.resolveTarget(effectiveModelAlias, true);
    if (target.kind !== 'custom' && target.kind !== 'managed') return target;
    const body: SubmitFeedbackBody = {
      session_id: input.sessionId,
      content: input.content,
      version: input.version,
      os: input.os,
      model: input.model,
      contact: input.contact,
      info: input.info,
    };
    const result =
      target.kind === 'custom'
        ? await fetchSubmitFeedback(target.url, target.token, body, { headers: target.headers })
        : await fetchSubmitFeedback(kimiCodeFeedbackUrl(target.baseUrl), target.token, body);
    if (result.kind === 'error') return { kind: 'error', message: result.message };

    const level = input.attachmentLevel;
    if (level !== 'logs' && level !== 'logs+codebase') {
      return { kind: 'ok', feedbackId: result.feedbackId };
    }
    let outcome: AttachmentOutcome = { failed: true };
    try {
      outcome = await this.uploadAttachments(target, result.feedbackId, input, level);
    } catch (error) {
      await this.logUploadError(error);
    }
    return outcome.failed || outcome.codebaseTruncated !== undefined
      ? {
          kind: 'ok',
          feedbackId: result.feedbackId,
          ...(outcome.failed ? { attachmentFailed: true } : {}),
          ...(outcome.codebaseTruncated === undefined
            ? {}
            : { codebaseTruncated: outcome.codebaseTruncated }),
        }
      : { kind: 'ok', feedbackId: result.feedbackId };
  }

  private async previewSession(sessionId?: string): Promise<ExportSessionPreview | undefined> {
    const id = nonEmpty(sessionId);
    if (id === undefined || this.sessionExport?.preview === undefined) return undefined;
    try {
      return await this.sessionExport.preview(id);
    } catch (error) {
      this.log?.warn('feedback session preview failed', { error });
      return undefined;
    }
  }

  private async uploadAttachments(
    target: Extract<FeedbackTarget, { readonly kind: 'custom' | 'managed' }>,
    feedbackId: number,
    input: FeedbackSubmitInput,
    level: Exclude<FeedbackAttachmentLevel, 'none'>,
  ): Promise<AttachmentOutcome> {
    const api = this.createUploadApi(target);
    if (level === 'logs') {
      const uploaded = await this.prepareAndUploadSessionArchive(api, feedbackId, input);
      return { failed: !uploaded };
    }
    const workDir = nonEmpty(input.workDir);
    const scan = workDir === undefined ? undefined : await this.scanCodebaseForFeedback(workDir);
    const [uploadedSession, uploadedCodebase] = await Promise.all([
      this.prepareAndUploadSessionArchive(api, feedbackId, input),
      this.prepareAndUploadCodebaseArchive(api, feedbackId, scan),
    ]);
    return {
      failed: !uploadedSession || !uploadedCodebase,
      ...(scan?.exceedsLimit === undefined ? {} : { codebaseTruncated: scan.exceedsLimit }),
    };
  }

  private createUploadApi(
    target: Extract<FeedbackTarget, { readonly kind: 'custom' | 'managed' }>,
  ): FeedbackUploadUrlApi {
    return {
      createUploadUrl: async (input) => {
        const body = {
          file_hash: input.sha256,
          file_name: input.filename,
          file_size: input.size,
          feedback_id: input.feedbackId,
        };
        const res =
          target.kind === 'custom'
            ? await fetchCreateFeedbackUploadUrl(target.token, body, {
                feedbackUrl: target.url,
                headers: target.headers,
              })
            : await fetchCreateFeedbackUploadUrl(target.token, body, { baseUrl: target.baseUrl });
        if (res.kind === 'error') throw new Error(res.message);
        return {
          uploadId: res.upload_id,
          parts: res.parts.map((part) => ({
            partNumber: part.part_number,
            url: part.url,
            method: part.method,
            size: part.size,
          })),
        };
      },
      completeUpload: async (input) => {
        const body = {
          upload_id: input.uploadId,
          parts: input.parts.map((part) => ({ part_number: part.partNumber, etag: part.etag })),
        };
        const res =
          target.kind === 'custom'
            ? await fetchCompleteFeedbackUpload(target.token, body, {
                feedbackUrl: target.url,
                headers: target.headers,
              })
            : await fetchCompleteFeedbackUpload(target.token, body, { baseUrl: target.baseUrl });
        if (res.kind === 'error') throw new Error(res.message);
      },
    };
  }

  private async prepareAndUploadSessionArchive(
    api: FeedbackUploadUrlApi,
    feedbackId: number,
    input: FeedbackSubmitInput,
  ): Promise<boolean> {
    return this.uploadProducedArchive(
      api,
      feedbackId,
      SESSION_ARCHIVE_FILENAME,
      async (archivePath) => {
        if (this.sessionExport === undefined) {
          throw new Error('cannot export session archive without sessionExportService');
        }
        const exported = await this.sessionExport.export({
          sessionId: input.sessionId,
          outputPath: archivePath,
          includeGlobalLog: true,
          version: input.version.replace(/^kimi-code-/, '') || input.version,
          installSource: input.installSource,
          shellEnv: input.shellEnv,
        });
        return archiveFromExportedSession(exported.zipPath);
      },
    );
  }

  private async prepareAndUploadCodebaseArchive(
    api: FeedbackUploadUrlApi,
    feedbackId: number,
    scan: FeedbackCodebaseScanResult | undefined,
  ): Promise<boolean> {
    if (scan === undefined) return false;
    return this.uploadProducedArchive(api, feedbackId, CODEBASE_ARCHIVE_FILENAME, (archivePath) =>
      packageCodebase(scan, archivePath),
    );
  }

  private async uploadProducedArchive(
    api: FeedbackUploadUrlApi,
    feedbackId: number,
    filename: string,
    produce: (archivePath: string) => Promise<FeedbackArchive>,
  ): Promise<boolean> {
    let cleanupDir: string | undefined;
    try {
      const target = await createFeedbackArchivePath(
        filename,
        this.bootstrap?.cacheDir ?? tmpdir(),
      );
      cleanupDir = target.cleanupDir;
      const archive = await produce(target.archivePath);
      await uploadArchive(api, { ...archive, cleanupDir: target.cleanupDir }, feedbackId, {
        filename,
      });
      return true;
    } catch (error) {
      await this.logUploadError(error);
      return false;
    } finally {
      if (cleanupDir !== undefined) {
        await rm(cleanupDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  private async scanCodebaseForFeedback(
    workDir: string,
  ): Promise<FeedbackCodebaseScanResult | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, CODEBASE_SCAN_TIMEOUT_MS);
    try {
      return await scanCodebase(workDir, { signal: controller.signal });
    } catch (error) {
      await this.logUploadError(error);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private async logUploadError(error: unknown): Promise<void> {
    this.log?.warn('feedback attachment upload failed', { error });
    if (this.bootstrap === undefined) return;
    try {
      await mkdir(this.bootstrap.logsDir, { recursive: true });
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      await appendFile(
        join(this.bootstrap.logsDir, 'feedback-upload.log'),
        `${new Date().toISOString()} ${message}\n`,
      );
    } catch {}
  }

  private async resolveTarget(
    modelAlias: string | undefined,
    refresh: boolean,
  ): Promise<FeedbackTarget> {
    const custom = this.customProvider(modelAlias);
    if (custom !== undefined) return this.customTarget(custom, refresh);
    return this.managedTarget(refresh);
  }

  private customProvider(modelAlias: string | undefined):
    | {
        modelId: string;
        model: ModelRecord;
        providerName: string;
        provider: ProviderConfig;
        feedbackUrl: string;
      }
    | undefined {
    const resolved = resolveActiveModelProvider(
      modelAlias,
      this.models,
      this.providers,
      this.config,
    );
    const feedbackUrl = nonEmpty(resolved?.provider.feedbackUrl);
    if (resolved === undefined || feedbackUrl === undefined) return undefined;
    return { ...resolved, feedbackUrl };
  }

  private async customTarget(
    resolved: {
      modelId: string;
      model: ModelRecord;
      providerName: string;
      provider: ProviderConfig;
      feedbackUrl: string;
    },
    refresh: boolean,
  ): Promise<FeedbackTarget> {
    let auth: ResolvedModelAuthMaterial;
    try {
      auth = resolveModelAuthMaterial(resolved);
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
    const credential = await this.bearer(resolved.providerName, auth, refresh);
    if ('kind' in credential) return credential;
    return {
      kind: 'custom',
      url: resolved.feedbackUrl,
      token: credential.token,
      headers: resolved.provider.customHeaders,
    };
  }

  private async bearer(
    providerName: string,
    auth: ResolvedModelAuthMaterial,
    refresh: boolean,
  ): Promise<{ readonly token: string } | { readonly kind: 'error'; readonly message: string }> {
    if (auth.apiKey !== undefined) return { token: auth.apiKey };
    if (auth.apiKeyEnv !== undefined) {
      const value = nonEmpty(process.env[auth.apiKeyEnv]);
      if (value === undefined) {
        return { kind: 'error', message: apiKeyEnvMissingMessage(providerName, auth.apiKeyEnv) };
      }
      return { token: value };
    }
    if (auth.oauth !== undefined) {
      const key = auth.oauthProviderKey ?? providerName;
      const token = refresh
        ? await this.oauth.resolveTokenProvider(key, auth.oauth)?.getAccessToken()
        : await this.oauth.getCachedAccessToken(key, auth.oauth);
      if (token === undefined) {
        return {
          kind: 'error',
          message: `Provider "${providerName}" declares feedback_url but has no OAuth token.`,
        };
      }
      return { token };
    }
    return {
      kind: 'error',
      message: `Provider "${providerName}" declares feedback_url but has no usable credential.`,
    };
  }

  private async managedTarget(refresh: boolean): Promise<FeedbackTarget> {
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    const auth = resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: provider?.baseUrl,
      configuredOAuthRef: provider?.oauth,
    });
    if (!refresh) {
      const status = await this.oauth.status(KIMI_CODE_PROVIDER_NAME);
      if (!status.loggedIn) return { kind: 'needs-login' };
      const token = await this.oauth.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME, auth.oauthRef);
      if (token === undefined) return { kind: 'needs-login' };
      return { kind: 'managed', baseUrl: auth.baseUrl, token };
    }
    const tokenProvider = this.oauth.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME, auth.oauthRef);
    if (tokenProvider === undefined) return { kind: 'needs-login' };
    try {
      return {
        kind: 'managed',
        baseUrl: auth.baseUrl,
        token: await tokenProvider.getAccessToken(),
      };
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }
}

export async function archiveFromExportedSession(zipPath: string): Promise<FeedbackArchive> {
  const archiveStat = await stat(zipPath);
  if (archiveStat.size > MAX_ARCHIVE_SIZE) {
    throw new Error(
      `Failed to upload archive: size ${archiveStat.size} exceeds maximum allowed size ${MAX_ARCHIVE_SIZE}.`,
    );
  }
  const sha256 = createHash('sha256');
  const fingerprint = createHash('sha256');
  for await (const chunk of createReadStream(zipPath)) {
    sha256.update(chunk as Buffer);
    fingerprint.update(chunk as Buffer);
  }
  return {
    path: zipPath,
    size: archiveStat.size,
    sha256: sha256.digest('hex'),
    fingerprint: fingerprint.digest('hex'),
    fileCount: 1,
  };
}

registerScopedService(
  LifecycleScope.App,
  IFeedbackService,
  FeedbackService,
  ScopeActivation.OnScopeCreated,
  'auth',
);
