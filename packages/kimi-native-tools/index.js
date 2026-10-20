/// TypeScript bindings for kimi-native-tools.
///
/// This file provides the JavaScript/TypeScript API that wraps the native
/// Rust module. It handles loading the correct platform-specific .node file
/// and provides typed wrappers for each tool.

const fs = require('node:fs');
const path = require('node:path');

// Platform-specific native module loading.
const BINDING_NAME = 'kimi-native-tools';

function loadBinding() {
  // Try the newer napi-rs naming first (includes MSVC suffix).
  try {
    return require(`./${BINDING_NAME}.${process.platform}-${process.arch}-msvc.node`);
  } catch {
    // Fall through to legacy naming.
  }

  // Try the GNU suffix (Linux artifacts: x86_64-unknown-linux-gnu, ...).
  try {
    return require(`./${BINDING_NAME}.${process.platform}-${process.arch}-gnu.node`);
  } catch {
    // Fall through.
  }

  // Try the standard napi-rs loading (platform-specific naming).
  try {
    return require(`./${BINDING_NAME}.${process.platform}-${process.arch}.node`);
  } catch {
    // Fall through.
  }

  // Try universal binding.
  try {
    return require(`./${BINDING_NAME}.node`);
  } catch {
    // Fall through.
  }

  // Try from release build directory (cargo build --release).
  const ext = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
  // Rust crate name is kimi_native_tools (underscores), JS package is kimi-native-tools (hyphens).
  const rustName = BINDING_NAME.replaceAll('-', '_');
  const releasePath = path.join(__dirname, 'target', 'release', `${rustName}.${ext}`);
  try {
    if (fs.existsSync(releasePath)) {
      return require(releasePath);
    }
  } catch {
    // Fall through.
  }

  // Try from debug build directory.
  const debugPath = path.join(__dirname, 'target', 'debug', `${rustName}.${ext}`);
  try {
    if (fs.existsSync(debugPath)) {
      return require(debugPath);
    }
  } catch {
    // Fall through.
  }

  throw new Error(
    `Failed to load kimi-native-tools binding for ${process.platform}-${process.arch}. ` +
      'Run `npm run build` or `cargo build --release` to compile the native module.',
  );
}

const binding = loadBinding();

// ============================================================================
// LLM Stream — HTTP SSE streaming with provider-specific event decoding
// ============================================================================

/**
 * Execute an LLM streaming request via Rust.
 *
 * Handles HTTP POST, SSE parsing, and provider-specific event decoding entirely
 * in Rust. Returns all decoded parts + metadata after the stream completes.
 *
 * @param {object} config - Stream configuration.
 * @param {string} config.provider - Provider name ("openai-responses" | "openai-legacy" | "anthropic").
 * @param {string} config.url - API endpoint URL.
 * @param {string} config.apiKey - API key / bearer token.
 * @param {string} config.model - Model name.
 * @param {string} config.requestBody - JSON request body string.
 * @param {number} [config.timeoutMs] - Request timeout in milliseconds.
 * @param {Array<{key: string, value: string}>} [config.extraHeaders] - Additional headers.
 * @returns {Promise<{parts: Array, metadata: object, error?: string}>}
 */
async function nativeLlmStream(config) {
  return binding.nativeLlmStream({
    provider: config.provider,
    url: config.url,
    apiKey: config.apiKey,
    model: config.model,
    requestBody: config.requestBody,
    timeoutMs: config.timeoutMs ?? undefined,
    extraHeaders: config.extraHeaders ?? null,
  });
}

/**
 * Execute an LLM streaming request via Rust with incremental delivery.
 *
 * Same Rust pipeline as {@link nativeLlmStream} but parts are forwarded to
 * `onEvent` as they are decoded (via a ThreadsafeFunction), so the JS side
 * observes tokens incrementally instead of after the whole stream completes.
 * The function returns immediately; the stream runs on a background thread.
 *
 * Follows Node callback conventions: `onEvent(err, event)` — `err` is `null`
 * on success; `event` is `{ kind: 'part'|'done'|'error', part?, metadata?, error? }`.
 *
 * @param {object} config - Stream configuration (same shape as nativeLlmStream).
 * @param {function} onEvent - `(err, event)` callback invoked per event.
 */
function nativeLlmStreamStreaming(config, onEvent) {
  return binding.nativeLlmStreamStreaming(
    {
      provider: config.provider,
      url: config.url,
      apiKey: config.apiKey,
      model: config.model,
      requestBody: config.requestBody,
      timeoutMs: config.timeoutMs ?? undefined,
      extraHeaders: config.extraHeaders ?? undefined,
    },
    onEvent,
  );
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  nativeLlmStream,
  nativeLlmStreamStreaming,
};
