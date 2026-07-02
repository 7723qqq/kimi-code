/**
 * `llmProtocol.tool` — v2's public `Tool` wire type.
 *
 * The name / description / JSON-Schema parameters carried across the wire when
 * v2 declares an available tool to the LLM. Downstream v2 code imports `Tool`
 * from here rather than from `@moonshot-ai/kosong`.
 */

export type { Tool } from '@moonshot-ai/kosong';
