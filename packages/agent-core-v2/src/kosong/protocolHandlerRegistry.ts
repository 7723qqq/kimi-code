/**
 * `kosong` domain (L1) — `IProtocolHandlerRegistry` contract and implementation.
 *
 * Builds the protocol adapter (`ChatProvider`) that speaks a given provider
 * `type`. A provider is a configured endpoint (baseUrl / apiKey / model); a
 * protocol handler is the adapter that speaks its wire protocol — different
 * providers may share one handler. Built-in handlers come from kosong
 * `createProvider`; `register` overrides or adds a handler per type. Bound at
 * Core scope.
 */

import type { ChatProvider, ProviderConfig, ProviderType } from '@moonshot-ai/kosong';
import { createProvider } from '@moonshot-ai/kosong';

import { InstantiationType } from '#/_base/di/extensions';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IConfigRegistry } from '#/config';

import {
  MODELS_SECTION,
  ModelsSectionSchema,
  modelsFromToml,
  modelsToToml,
} from './configSection';

export type ProtocolHandlerFactory = (config: ProviderConfig) => ChatProvider;

export interface IProtocolHandlerRegistry {
  readonly _serviceBrand: undefined;
  create(config: ProviderConfig): ChatProvider;
  register(type: ProviderType, factory: ProtocolHandlerFactory): void;
}

export const IProtocolHandlerRegistry: ServiceIdentifier<IProtocolHandlerRegistry> =
  createDecorator<IProtocolHandlerRegistry>('protocolHandlerRegistry');

export class ProtocolHandlerRegistry implements IProtocolHandlerRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly overrides = new Map<ProviderType, ProtocolHandlerFactory>();

  constructor(@IConfigRegistry configRegistry: IConfigRegistry) {
    configRegistry.registerSection(MODELS_SECTION, ModelsSectionSchema, {
      fromToml: modelsFromToml,
      toToml: modelsToToml,
    });
  }

  create(config: ProviderConfig): ChatProvider {
    const factory = this.overrides.get(config.type);
    return factory !== undefined ? factory(config) : createProvider(config);
  }

  register(type: ProviderType, factory: ProtocolHandlerFactory): void {
    this.overrides.set(type, factory);
  }
}

registerScopedService(
  LifecycleScope.Core,
  IProtocolHandlerRegistry,
  ProtocolHandlerRegistry,
  InstantiationType.Delayed,
  'kosong',
);
