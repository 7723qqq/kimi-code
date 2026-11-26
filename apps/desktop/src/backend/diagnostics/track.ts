import type { TelemetryProperties } from '@moonshot-ai/agent-core-v2';

type TrackImpl = (event: string, properties?: TelemetryProperties) => void;

const MAX_PENDING_EVENTS = 200;

let impl: TrackImpl | null = null;
let pending: Array<{ event: string; properties?: TelemetryProperties }> = [];

export function setDesktopTrackImpl(next: TrackImpl | null): void {
  impl = next;
  if (impl === null) {
    pending = [];
    return;
  }
  const replay = pending;
  pending = [];
  for (const { event, properties } of replay) {
    try {
      impl(event, properties);
    } catch {}
  }
}

export function trackDesktopEvent(event: string, properties?: TelemetryProperties): void {
  if (impl === null) {
    if (pending.length >= MAX_PENDING_EVENTS) pending.shift();
    pending.push({ event, properties });
    return;
  }
  impl(event, properties);
}

export function trySendDesktopEvent(event: string, properties?: TelemetryProperties): void {
  try {
    trackDesktopEvent(event, properties);
  } catch {}
}

let runtimeLocale: string | undefined;

export function setRuntimeLocale(next: string | undefined): void {
  runtimeLocale = next;
}

export function getRuntimeLocale(): string | undefined {
  return runtimeLocale;
}
