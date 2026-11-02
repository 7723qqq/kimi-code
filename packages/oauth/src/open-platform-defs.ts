export interface OpenPlatformDefinition {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly consoleUrl?: string;
  readonly providerType?: string;
  readonly allowedPrefixes?: readonly string[] | undefined;
}

export const OPEN_PLATFORMS: readonly OpenPlatformDefinition[] = [
  {
    id: 'moonshot-cn',
    name: 'Kimi Platform (API key · platform.kimi.com)',
    baseUrl: 'https://api.moonshot.cn/v1',
    consoleUrl: 'https://platform.kimi.com',
    allowedPrefixes: ['kimi-k'],
  },
  {
    id: 'moonshot-ai',
    name: 'Kimi Platform (API key · platform.kimi.ai)',
    baseUrl: 'https://api.moonshot.ai/v1',
    consoleUrl: 'https://platform.kimi.ai',
    allowedPrefixes: ['kimi-k'],
  },
  {
    id: 'google-aistudio',
    name: 'Google AI Studio (API key · aistudio.google.com)',
    baseUrl: 'https://generativelanguage.googleapis.com',
    consoleUrl: 'https://aistudio.google.com',
    providerType: 'google-genai',
  },
  {
    id: 'astron',
    name: 'Xunfei Coding Plan (API key · xfyun.cn)',
    baseUrl: 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v2',
    consoleUrl: 'https://www.xfyun.cn',
  },
];

export function getOpenPlatformById(id: string): OpenPlatformDefinition | undefined {
  return OPEN_PLATFORMS.find((p) => p.id === id);
}

export function isOpenPlatformId(id: string): boolean {
  return OPEN_PLATFORMS.some((p) => p.id === id);
}
