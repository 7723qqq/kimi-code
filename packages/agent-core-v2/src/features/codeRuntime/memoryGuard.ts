import { dlopen, FFIType } from 'bun:ffi';
import { readFileSync } from 'node:fs';

export class MemoryCapUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryCapUnavailableError';
  }
}

export const MEMORY_CAP_BYTES = 512 * 1024 * 1024;

export interface MemoryGuard {
  exceeded(): boolean;
  peakBytes(): number | undefined;
  dispose(): void;
}

const WIN32_EXTENDED_LIMIT_INFO_CLASS = 9;
const WIN32_LIMIT_PROCESS_MEMORY = 0x00000100;
const WIN32_LIMIT_JOB_MEMORY = 0x00000200;
const WIN32_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const WIN32_PROCESS_SET_QUOTA = 0x0100;
const WIN32_PROCESS_TERMINATE = 0x0001;
const WIN32_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const WIN32_EXTENDED_LIMIT_SIZE = 144;
const WIN32_PEAK_JOB_MEMORY_OFFSET = 128;

interface Win32Kernel32 {
  CreateJobObjectW(extra: unknown, name: unknown): unknown;
  SetInformationJobObject(job: unknown, infoClass: number, info: ArrayBuffer, size: number): boolean;
  AssignProcessToJobObject(job: unknown, process: unknown): boolean;
  QueryInformationJobObject(job: unknown, infoClass: number, info: ArrayBuffer, size: number, retLen: unknown): boolean;
  OpenProcess(access: number, inherit: boolean, pid: number): unknown;
  CloseHandle(handle: unknown): boolean;
}

let kernel32Cache: Win32Kernel32 | null | undefined;

function loadKernel32(): Win32Kernel32 | null {
  if (kernel32Cache !== undefined) return kernel32Cache;
  try {
    const lib = dlopen('kernel32.dll', {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
      AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      QueryInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.bool },
      OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
    });
    kernel32Cache = lib.symbols as unknown as Win32Kernel32;
  } catch {
    kernel32Cache = null;
  }
  return kernel32Cache;
}

function buildExtendedLimits(capBytes: number): ArrayBuffer {
  const buf = new ArrayBuffer(WIN32_EXTENDED_LIMIT_SIZE);
  new Uint32Array(buf)[4] =
    WIN32_LIMIT_PROCESS_MEMORY | WIN32_LIMIT_JOB_MEMORY | WIN32_LIMIT_KILL_ON_JOB_CLOSE;
  const u64 = new BigUint64Array(buf);
  u64[14] = BigInt(capBytes);
  u64[15] = BigInt(capBytes);
  return buf;
}

function createWindowsGuard(pid: number, capBytes: number): MemoryGuard {
  const k32 = loadKernel32();
  if (k32 === null) {
    throw new MemoryCapUnavailableError('bun:ffi cannot load kernel32.dll on this Windows host');
  }
  const job = k32.CreateJobObjectW(null, null);
  if (job === null || job === 0) {
    throw new MemoryCapUnavailableError('CreateJobObjectW failed');
  }
  let processHandle: unknown = null;
  try {
    if (!k32.SetInformationJobObject(job, WIN32_EXTENDED_LIMIT_INFO_CLASS, buildExtendedLimits(capBytes), WIN32_EXTENDED_LIMIT_SIZE)) {
      throw new MemoryCapUnavailableError('SetInformationJobObject rejected the memory limits');
    }
    processHandle = k32.OpenProcess(
      WIN32_PROCESS_SET_QUOTA | WIN32_PROCESS_TERMINATE | WIN32_PROCESS_QUERY_LIMITED_INFORMATION,
      false,
      pid,
    );
    if (processHandle === null || processHandle === 0) {
      throw new MemoryCapUnavailableError(`OpenProcess failed for pid ${pid}`);
    }
    if (!k32.AssignProcessToJobObject(job, processHandle)) {
      throw new MemoryCapUnavailableError(`AssignProcessToJobObject failed for pid ${pid}`);
    }
  } catch (error) {
    k32.CloseHandle(job);
    if (processHandle !== null && processHandle !== 0) k32.CloseHandle(processHandle);
    throw error;
  }
  let peakJobMemoryBytes: number | undefined;
  const queryPeakJobMemoryBytes = (): number | undefined => {
    const buf = new ArrayBuffer(WIN32_EXTENDED_LIMIT_SIZE);
    if (!k32.QueryInformationJobObject(job, WIN32_EXTENDED_LIMIT_INFO_CLASS, buf, WIN32_EXTENDED_LIMIT_SIZE, null)) {
      return peakJobMemoryBytes;
    }
    peakJobMemoryBytes = Number(
      new DataView(buf).getBigUint64(WIN32_PEAK_JOB_MEMORY_OFFSET, true),
    );
    return peakJobMemoryBytes;
  };
  let disposed = false;
  return {
    exceeded: () => (queryPeakJobMemoryBytes() ?? 0) >= capBytes,
    peakBytes: () => queryPeakJobMemoryBytes(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      k32.CloseHandle(job);
      k32.CloseHandle(processHandle);
    },
  };
}

function parseLinuxStatusRss(text: string): number | undefined {
  const match = /^VmRSS:\s*(\d+)\s*kB$/m.exec(text);
  if (match === null) return undefined;
  return Number(match[1]) * 1024;
}

function createLinuxGuard(pid: number, capBytes: number, kill: () => void): MemoryGuard {
  const statusPath = `/proc/${String(pid)}/status`;
  try {
    readFileSync(statusPath, 'utf8');
  } catch {
    throw new MemoryCapUnavailableError(`/proc is not readable for pid ${pid}; cannot enforce a memory cap`);
  }
  let hit = false;
  let disposed = false;
  const timer = setInterval(() => {
    if (disposed || hit) return;
    let text: string;
    try {
      text = readFileSync(statusPath, 'utf8');
    } catch {
      return;
    }
    const rss = parseLinuxStatusRss(text);
    if (rss !== undefined && rss > capBytes) {
      hit = true;
      kill();
    }
  }, 25);
  timer.unref();
  return {
    exceeded: () => hit,
    peakBytes: () => {
      return;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
    },
  };
}

function createDarwinGuard(pid: number, capBytes: number, kill: () => void): MemoryGuard {
  try {
    const probe = Bun.spawnSync({ cmd: ['ps', '-o', 'rss=', '-p', String(pid)], stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
    if (probe.exitCode !== 0) throw new Error('ps probe failed');
  } catch {
    throw new MemoryCapUnavailableError('ps is not usable on this host; cannot enforce a memory cap');
  }
  let hit = false;
  let disposed = false;
  let polling = false;
  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const proc = Bun.spawn({ cmd: ['ps', '-o', 'rss=', '-p', String(pid)], stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const kb = Number.parseInt(out.trim(), 10);
      if (Number.isFinite(kb) && kb * 1024 > capBytes) {
        hit = true;
        kill();
      }
    } catch (pollError) {
      void pollError;
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => {
    if (disposed || hit) return;
    void poll();
  }, 100);
  timer.unref();
  return {
    exceeded: () => hit,
    peakBytes: () => {
      return;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
    },
  };
}

export function createMemoryGuard(pid: number, capBytes: number, kill: () => void): MemoryGuard {
  switch (process.platform) {
    case 'win32':
      return createWindowsGuard(pid, capBytes);
    case 'linux':
      return createLinuxGuard(pid, capBytes, kill);
    case 'darwin':
      return createDarwinGuard(pid, capBytes, kill);
    default:
      throw new MemoryCapUnavailableError(`no memory cap enforcement is implemented for platform ${process.platform}`);
  }
}
