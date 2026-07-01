/**
 * `model` domain (L2) — model-alias configuration registry contract.
 *
 * Owns the `ModelAlias` model and the `models` config section (alias → provider
 * + model + context/capabilities); exposes CRUD over model aliases and persists
 * them through `config`. App-scoped — model aliases are global and shared
 * across sessions.
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export const MODELS_SECTION = 'models';

export const ModelAliasSchema = z.object({
  provider: z.string(),
  model: z.string(),
  maxContextSize: z.number().int().min(1),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
});

export type ModelAlias = z.infer<typeof ModelAliasSchema>;

export const ModelsSectionSchema = z.record(z.string(), ModelAliasSchema);

export type ModelsSection = z.infer<typeof ModelsSectionSchema>;

export interface ModelsChangedEvent {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface IModelService {
  readonly _serviceBrand: undefined;
  readonly onDidChangeModels: Event<ModelsChangedEvent>;
  get(alias: string): ModelAlias | undefined;
  list(): Readonly<Record<string, ModelAlias>>;
  set(alias: string, model: ModelAlias): Promise<void>;
  delete(alias: string): Promise<void>;
}

export const IModelService: ServiceIdentifier<IModelService> =
  createDecorator<IModelService>('modelService');
