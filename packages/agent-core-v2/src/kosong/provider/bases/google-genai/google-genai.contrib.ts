/**
 * `kosong/provider` domain — side-effect module: registers the Google
 * GenAI base (`id: 'google-genai'`).
 *
 * The Gemini base carries no hook surface, so the factory only aggregates the
 * construction-time declarations. Vertex AI is a mode of this base — not a
 * protocol of its own — enabled through the adapter config's
 * `providerOptions` (`vertexai` / `project` / `location`), which the factory
 * forwards to the SDK client options. The `apiKey ?? ''` guard ensures that
 * once a trait declared an endpoint, the base's `GOOGLE_API_KEY` environment
 * fallback is suppressed.
 */

import { registerProtocolBase } from '#/kosong/protocol/protocolBase';
import { traitDefaultHeaders } from '#/kosong/protocol/protocolTrait';

import {
  compactObject,
  firstProcessEnv,
  traitEndpoint,
  traitProvides,
} from '../openai/openaiHooks';
import { isUnknownCapability } from '@moonshot-ai/kosong/capability';
import { getGoogleGenAIModelCapability } from '@moonshot-ai/kosong/providers/capability-registry';
import { GoogleGenAIChatProvider } from './google-genai';

registerProtocolBase({
  id: 'google-genai',
  capability: (modelName) => {
    const capability = getGoogleGenAIModelCapability(modelName);
    return isUnknownCapability(capability) ? undefined : capability;
  },
  createChatProvider({ config, traits }) {
    const endpoint = traitEndpoint(traits);
    return new GoogleGenAIChatProvider({
      ...(traitProvides(traits) as Partial<
        ConstructorParameters<typeof GoogleGenAIChatProvider>[0]
      >),
      model: config.modelName,
      ...compactObject({
        apiKey:
          config.apiKey ??
          firstProcessEnv(endpoint?.apiKeyEnv) ??
          (endpoint === undefined ? undefined : ''),
        baseUrl:
          config.baseUrl ?? firstProcessEnv(endpoint?.baseUrlEnv) ?? endpoint?.defaultBaseUrl,
        defaultHeaders: traitDefaultHeaders(traits),
        vertexai: config.providerOptions?.vertexai,
        project: config.providerOptions?.project,
        location: config.providerOptions?.location,
      }),
    });
  },
});
