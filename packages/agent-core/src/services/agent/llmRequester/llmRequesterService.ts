import { registerSingleton, SyncDescriptor } from '../../../di';

import { IProfileService } from '../profile/profile';
import { IContextMemory } from '../contextMemory/contextMemory';
import { IContextProjector } from '../contextProjector/contextProjector';
import { IToolRegistry } from '../toolRegistry/toolRegistry';
import type { LLMEvent, LLMRequestOverrides } from '../types';
import { ILLMRequester } from './llmRequester';

export class LLMRequesterService implements ILLMRequester {
  constructor(
    @IContextMemory private readonly context: IContextMemory,
    @IContextProjector private readonly projector: IContextProjector,
    @IToolRegistry private readonly tools: IToolRegistry,
    @IProfileService private readonly profile: IProfileService,
  ) {}

  request(
    overrides: LLMRequestOverrides = {},
    signal?: AbortSignal,
  ): AsyncIterable<LLMEvent> {
    signal?.throwIfAborted();
    void (overrides.messages ?? this.projector.project(this.context.getHistory()));
    void (overrides.tools ?? this.defaultTools());
    void (overrides.systemPrompt ?? this.profile.getSystemPrompt());
    throw new Error('No LLM transport is configured for ILLMRequester');
  }

  private defaultTools(): ReturnType<IToolRegistry['list']> {
    return this.tools.list().filter((tool) => this.profile.isToolActive(tool.name));
  }
}

registerSingleton(ILLMRequester, new SyncDescriptor(LLMRequesterService, [], true));
