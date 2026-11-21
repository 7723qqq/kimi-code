import { isDesktopNow } from '@moonshot-ai/app-core/lib';

const DESKTOP_LOGIN_SOURCE = 'kimi_code_desktop';

export function withDesktopLoginSource(url: string): string {
  if (!isDesktopNow()) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('from', DESKTOP_LOGIN_SOURCE);
    return parsed.toString();
  } catch {
    return url;
  }
}
