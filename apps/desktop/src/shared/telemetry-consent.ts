const TRUE_ENV_VALUES = new Set(['1', 'true', 't', 'yes', 'y']);

export function isTelemetryConsentEnabled(
  configValue: unknown,
  envValue: string | undefined,
): boolean {
  return (
    !(envValue !== undefined && TRUE_ENV_VALUES.has(envValue.trim().toLowerCase())) &&
    configValue !== false
  );
}
