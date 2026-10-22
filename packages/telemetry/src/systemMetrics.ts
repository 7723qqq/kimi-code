import { cpus, freemem, loadavg, totalmem } from 'node:os';

import type { TelemetryProperties } from './types';

const DEFAULT_INTERVAL_MS = 300_000;
const DEFAULT_WARMUP_SAMPLE_MS = 1_500;
const SYSTEM_METRICS_EVENT = 'system_metrics';

export interface SystemMetricsTrackClient {
  track(event: string, properties?: TelemetryProperties): void;
}

export interface SystemMetricsTimerHandle {
  unref?(): void;
}

export interface SystemMetricsTimers {
  setTimeout(callback: () => void, delayMs: number): SystemMetricsTimerHandle;
  clearTimeout(handle: SystemMetricsTimerHandle): void;
  setInterval(callback: () => void, intervalMs: number): SystemMetricsTimerHandle;
  clearInterval(handle: SystemMetricsTimerHandle): void;
}

export const SYSTEM_METRICS_TIMERS: SystemMetricsTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface SystemMetricsCollectorOptions {
  readonly client: SystemMetricsTrackClient;
  readonly intervalMs?: number;
  readonly warmupSampleMs?: number | null;
  readonly timers?: SystemMetricsTimers;
}

export class SystemMetricsCollector {
  private readonly client: SystemMetricsTrackClient;
  private readonly intervalMs: number;
  private readonly warmupSampleMs: number | null;
  private readonly timers: SystemMetricsTimers;
  private intervalTimer: SystemMetricsTimerHandle | null = null;
  private warmupTimer: SystemMetricsTimerHandle | null = null;
  private previousCpuUsage = process.cpuUsage();
  private previousHrtime = process.hrtime.bigint();
  private readonly processStartedAtSeconds = Math.floor(Date.now() / 1000 - process.uptime());

  constructor(options: SystemMetricsCollectorOptions) {
    this.client = options.client;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.warmupSampleMs =
      options.warmupSampleMs === undefined ? DEFAULT_WARMUP_SAMPLE_MS : options.warmupSampleMs;
    this.timers = options.timers ?? SYSTEM_METRICS_TIMERS;
  }

  start(): void {
    if (this.intervalTimer !== null) return;

    if (this.warmupSampleMs !== null && this.warmupSampleMs > 0) {
      this.warmupTimer = this.timers.setTimeout(() => {
        this.warmupTimer = null;
        this.sampleSafely();
      }, this.warmupSampleMs);
      this.warmupTimer.unref?.();
    }

    this.intervalTimer = this.timers.setInterval(() => {
      this.sampleSafely();
    }, this.intervalMs);
    this.intervalTimer.unref?.();
  }

  stop(): void {
    if (this.warmupTimer !== null) {
      this.timers.clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
    if (this.intervalTimer !== null) {
      this.timers.clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  private sampleSafely(): void {
    try {
      this.sample();
    } catch {
      this.stop();
    }
  }

  private sample(): void {
    const now = process.hrtime.bigint();
    const elapsedUs = Number(now - this.previousHrtime) / 1_000;

    const cpu = process.cpuUsage(this.previousCpuUsage);
    this.previousCpuUsage = process.cpuUsage();
    this.previousHrtime = now;

    const mem = process.memoryUsage();
    const constrainedMemory = getConstrainedMemoryBytes();
    const properties: TelemetryProperties = {
      process_started_at: this.processStartedAtSeconds,
      process_uptime_ms: Math.round(process.uptime() * 1000),
      rss_bytes: mem.rss,
      heap_used_bytes: mem.heapUsed,
      heap_total_bytes: mem.heapTotal,
      external_bytes: mem.external,
      array_buffers_bytes: mem.arrayBuffers,
      cpu_user_us: cpu.user,
      cpu_system_us: cpu.system,
      cpu_elapsed_us: Math.round(elapsedUs),
      load_avg_1m: loadavg()[0],
      free_mem_bytes: freemem(),
      total_mem_bytes: totalmem(),
      cpu_count: cpus().length,
    };
    if (constrainedMemory !== undefined) {
      properties['constrained_memory_bytes'] = constrainedMemory;
    }

    this.client.track(SYSTEM_METRICS_EVENT, properties);
  }
}

function getConstrainedMemoryBytes(): number | undefined {
  if (typeof process.constrainedMemory !== 'function') return undefined;
  const value = process.constrainedMemory();
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
