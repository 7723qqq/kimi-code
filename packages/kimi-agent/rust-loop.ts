/// Rust agent engine adapter.
///
/// When `agent.engine = "rust"` is configured, this module provides
/// a drop-in replacement for the JS turn loop by starting the
/// `kimi-agent` Rust binary as a child process and communicating
/// with it via stdio JSON-RPC.
///
/// If the Rust binary is not found or fails to start, it falls back
/// to the JS implementation automatically.

import { ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { appRoot } from '../../scripts/native/paths.mjs';

// ── Types matching the Rust agent protocol ─────────────────────────────────

interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface RunTurnParams {
  turn_id: string;
  system_prompt: string;
  model_name: string;
  messages: { role: string; content: string }[];
  tools: { name: string; description: string; input_schema: unknown }[];
  max_steps?: number;
}

interface RunTurnResult {
  stop_reason: string;
  steps: number;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

// ── Agent process manager ──────────────────────────────────────────────────

class AgentProcess {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private ready = false;

  /**
   * Find the kimi-agent binary.
   * Checks the same locations as 03-inject.mjs checks for kimi-build.
   */
  private static findBinary(): string | null {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const candidates = [
      resolve(appRoot, 'packages/kimi-agent/target/release/kimi-agent' + ext),
      resolve(appRoot, 'packages/kimi-agent/target/debug/kimi-agent' + ext),
    ];
    try {
      const fs = require('node:fs');
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Start the agent process. Returns true if successful, false if the binary
   * is not available.
   */
  start(): boolean {
    const binaryPath = AgentProcess.findBinary();
    if (!binaryPath) {
      console.warn('[kimi-agent] Binary not found, falling back to JS engine');
      return false;
    }

    try {
      this.process = spawn(binaryPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Read stdout for responses
      this.process.stdout!.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      // Read stderr for diagnostics
      this.process.stderr!.on('data', (data: Buffer) => {
        console.error(`[kimi-agent] ${data.toString().trim()}`);
      });

      // Handle process exit
      this.process.on('exit', (code) => {
        console.warn(`[kimi-agent] Process exited with code ${code}`);
        this.process = null;
        // Reject all pending requests
        for (const [id, { reject }] of this.pending) {
          reject(new Error(`Agent process exited with code ${code}`));
          this.pending.delete(id);
        }
      });

      this.ready = true;
      return true;
    } catch (err) {
      console.warn('[kimi-agent] Failed to start:', err);
      return false;
    }
  }

  /**
   * Process buffered stdout data, extracting complete JSON-RPC responses.
   */
  private processBuffer() {
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const response = JSON.parse(trimmed) as RpcResponse;
        const pending = this.pending.get(response.id);
        if (pending) {
          if (response.error) {
            pending.reject(new Error(response.error.message));
          } else {
            pending.resolve(response.result);
          }
          this.pending.delete(response.id);
        }
      } catch {
        // Ignore malformed JSON
      }
    }
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.process || !this.ready) {
      throw new Error('Agent process is not running');
    }

    const id = this.nextId++;
    const request: RpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process!.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  /**
   * Stop the agent process.
   */
  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.ready = false;
  }
}

// ── Singleton process instance ─────────────────────────────────────────────

let agentProcess: AgentProcess | null = null;
let fallbackToJs = false;

/**
 * Get or create the agent process singleton.
 */
function getAgent(): AgentProcess | null {
  if (fallbackToJs) return null;
  if (!agentProcess) {
    agentProcess = new AgentProcess();
    if (!agentProcess.start()) {
      agentProcess = null;
      fallbackToJs = true;
      return null;
    }
  }
  return agentProcess;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Run a turn using the Rust agent engine (or fall back to JS).
 *
 * @returns The turn result, or null if the Rust engine is not available
 *          (caller should use the JS implementation instead).
 */
export async function runTurnRust(params: RunTurnParams): Promise<RunTurnResult | null> {
  const agent = getAgent();
  if (!agent) {
    return null; // Fall back to JS
  }

  try {
    const result = await agent.request('agent/run_turn', params);
    return result as RunTurnResult;
  } catch (err) {
    console.error('[kimi-agent] RPC call failed:', err);
    return null; // Fall back to JS
  }
}

/**
 * Check if the Rust agent engine is available.
 */
export function isRustEngineAvailable(): boolean {
  return AgentProcess.findBinary() !== null;
}

/**
 * Clean up the agent process.
 */
export function shutdownRustEngine() {
  if (agentProcess) {
    agentProcess.stop();
    agentProcess = null;
  }
}