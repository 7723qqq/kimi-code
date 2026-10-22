import type { ProviderMediaContribution } from '#/llm/media/upload';
import { modelKey, type LlmModel } from '#/llm/model';

import { KimiFiles, type KimiFilesFetch } from './files';
import { KIMI_DEFAULT_BASE_URL } from './trait';

const filesByModel = new Map<string, KimiFiles>();

export interface KimiMediaContributionOptions {
  readonly fetch?: KimiFilesFetch;
}

function createFiles(model: LlmModel, mediaFetch?: KimiFilesFetch): KimiFiles {
  return new KimiFiles({
    apiKey: model.apiKey,
    baseUrl: model.baseUrl ?? KIMI_DEFAULT_BASE_URL,
    defaultHeaders: model.defaultHeaders === undefined ? undefined : { ...model.defaultHeaders },
    ...(mediaFetch === undefined ? {} : { fetch: mediaFetch }),
  });
}

function resolveFiles(model: LlmModel, mediaFetch?: KimiFilesFetch): KimiFiles {
  if (mediaFetch !== undefined) {
    return createFiles(model, mediaFetch);
  }
  const key = modelKey(model);
  let files = filesByModel.get(key);
  if (files === undefined) {
    files = createFiles(model);
    filesByModel.set(key, files);
  }
  return files;
}

export function createKimiMediaContribution(
  options: KimiMediaContributionOptions = {},
): ProviderMediaContribution {
  return {
    uploadVideo: (video, { model, signal }) =>
      resolveFiles(model, options.fetch).uploadVideo(video, { signal }),
  };
}

export const kimiMediaContribution: ProviderMediaContribution = createKimiMediaContribution();
