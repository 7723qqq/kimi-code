#!/usr/bin/env node
// Stdio MCP server for kimi-datasource.
//
// Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout per the MCP "stdio"
// transport. Implements the minimal surface the Kimi Code host calls:
//   - initialize
//   - notifications/initialized
//   - tools/list
//   - tools/call
//   - ping
//
// Business logic is kept self-contained so the plugin can run from a zipped
// marketplace install without workspace package dependencies.
//
// Every ambient dependency (env, fetch, timers, stdio, exit, os, uuid) is
// reachable through the host record built by createHost(), so the server can be
// driven in-process; the defaults reproduce the plain node process exactly.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, homedir, hostname, release, type } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const VERSION = '3.4.0';
const DEFAULT_KIMI_CODE_OAUTH_HOST = 'https://auth.kimi.com';
const DEFAULT_KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';
const REQUEST_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = '2025-06-18';

const NODE_OS = { arch, homedir, hostname, release, type };

const TOOLS = [
  {
    name: 'call_data_source_tool',
    description:
      "Dispatch one call to the data source selected for the user's request. Always call get_data_source_desc(name) first, then use an api_name and params from that description. For a simple lookup, use one specialized source and stop once a result covers the user's question; do not query fallback or comparison sources unless the user explicitly asks for a cross-source comparison. When the user names a data source, use that source.",
    inputSchema: {
      type: 'object',
      properties: {
        data_source_name: {
          type: 'string',
          description:
            'The data source selected via get_data_source_desc. When the user names a source, pass that source.',
        },
        api_name: {
          type: 'string',
          description: 'API name from the data source description.',
        },
        params: {
          type: 'object',
          description: 'API parameters that match the data source description.',
        },
      },
      required: ['data_source_name', 'api_name', 'params'],
    },
  },
  {
    name: 'get_data_source_desc',
    description:
      'Get the current API documentation for one Kimi data source before calling a specific API. For a simple lookup, choose exactly one specialized source; do not inspect fallback or comparison sources unless the user explicitly asks for a cross-source comparison.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: [
            'stock_finance_data',
            'yahoo_finance',
            'world_bank_open_data',
            'tianyancha',
            'arxiv',
            'scholar',
            'yuandian_law',
            'wind',
            'imf',
            'gildata',
            'sec_edgar',
            'sp_data',
            'china_nda',
            'china_nbs',
            'china_standards',
            'who',
            'fao',
            'unsd',
            'ecb',
            'eurostat',
            'unicef',
            'oecd',
            'fred',
            'xhcj',
            'caixin',
          ],
          description:
            'Data source name. Capabilities: stock_finance_data / yahoo_finance = general quotes and financials ' +
            '(yahoo_finance FX history is limited to about 2 years); world_bank_open_data = historical macro; ' +
            'imf = FX rates, CPI, GDP forecasts, balance of payments; tianyancha = CN company registry; ' +
            'arxiv / scholar = papers; yuandian_law = CN laws and cases; ' +
            'wind = A-share intraday minute series, funds, bonds (map PE/PB/ROE-style field names via wind_search_fields first); ' +
            'gildata = natural-language stock/fund screening; ' +
            'sec_edgar = US filings (10-K/10-Q, S-1, Form 4, 13F, 8-K); ' +
            'sp_data = S&P fundamentals (consensus estimates, valuation ratios, transcripts); ' +
            'china_nda = CN government open data catalogs (National Data Administration registry + provincial platforms); ' +
            'china_nbs = CN NBS macro indicators and time series (national / provincial / major-city scopes); ' +
            'china_standards = CN standards (GB national, HB industry, DB local, TT association); ' +
            'who / fao / unsd / ecb / eurostat / unicef / oecd / fred = international organization open data ' +
            '(global health, food & agriculture, UN statistics, ECB & EU statistics, child indicators, OECD datasets, US & global macro series); ' +
            'xhcj = Xinhua Finance (CNFIC) news flashes, announcements, and policies; ' +
            'caixin = Caixin database (600+ data APIs, discover via caixin_api_search first).',
        },
      },
      required: ['name'],
    },
  },
];

const HANDLERS = {
  call_data_source_tool: {
    method: 'call_data_source_tool',
    buildParams(args) {
      return {
        data_source_name: requiredString(args, 'data_source_name'),
        api_name: requiredString(args, 'api_name'),
        params: requiredObject(args, 'params'),
      };
    },
  },
  get_data_source_desc: {
    method: 'get_data_source_desc',
    buildParams(args) {
      return { name: requiredString(args, 'name') };
    },
  },
};

// Build the ambient-dependency record the server runs against. Every override is
// optional; an omitted entry keeps the plain node global.
export function createHost(overrides = {}) {
  return {
    env: overrides.env ?? process.env,
    fetch: overrides.fetch ?? ((input, init) => fetch(input, init)),
    setTimeout: overrides.setTimeout ?? systemSetTimeout,
    clearTimeout: overrides.clearTimeout ?? systemClearTimeout,
    stdin: overrides.stdin ?? process.stdin,
    stdout: overrides.stdout ?? process.stdout,
    exit: overrides.exit ?? ((code) => process.exit(code)),
    os: overrides.os ?? NODE_OS,
    uuid: overrides.uuid ?? (() => randomUUID()),
  };
}

function systemSetTimeout(callback, delayMs) {
  return setTimeout(() => {
    callback();
  }, delayMs);
}

function systemClearTimeout(handle) {
  clearTimeout(handle);
}

async function handleRequest(host, message) {
  const { method, id, params } = message;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'kimi-datasource', version: VERSION },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return runTool(host, params);
    default:
      throw jsonRpcError(-32601, `Method not found: ${method}`, { id });
  }
}

async function runTool(host, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  const handler = HANDLERS[name];
  if (handler === undefined) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }],
      isError: true,
    };
  }
  const trace = {};
  try {
    const built = handler.buildParams(args);
    const response = await callKimiTool(host, handler.method, built, trace);
    const fileWarnings = await writeResponseFiles(response, expectedResponseFilePath(built));
    const text = extractText(response);
    const formatted = (handler.format?.(text, built) ?? text).trim();
    return { content: [{ type: 'text', text: appendTrace(appendWarnings(formatted, fileWarnings), trace) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: appendTrace(message, trace) }],
      isError: true,
    };
  }
}

async function writeResponseFiles(response, expectedOutputPath) {
  if (!isRecord(response) || !Array.isArray(response.files)) return [];
  const warnings = [];

  for (const file of response.files) {
    if (!isRecord(file)) continue;
    const name = typeof file.name === 'string' ? file.name.trim() : '';
    if (name.length === 0 || file.content === undefined || file.content === null) continue;

    const writePath = allowedResponseFilePath(name, expectedOutputPath);
    if (writePath === undefined) {
      warnings.push(`Warning: skipped returned file ${name} because it is outside the requested output path.`);
      continue;
    }

    try {
      await mkdir(path.dirname(writePath), { recursive: true });
      if (file.encoding === 'base64') {
        await writeFile(writePath, Buffer.from(String(file.content), 'base64'));
      } else {
        await writeFile(writePath, String(file.content), 'utf8');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Warning: failed to write file ${writePath}: ${message}`);
    }
  }

  return warnings;
}

function expectedResponseFilePath(params) {
  return outputPathField(params) ?? (isRecord(params) ? outputPathField(params.params) : undefined);
}

function outputPathField(value) {
  if (!isRecord(value)) return undefined;
  for (const field of ['file_path', 'filepath']) {
    const pathValue = value[field];
    if (typeof pathValue !== 'string') continue;
    const trimmed = pathValue.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function allowedResponseFilePath(name, expectedOutputPath) {
  if (expectedOutputPath === undefined) return undefined;

  const actual = path.resolve(name);
  const expected = path.resolve(expectedOutputPath);
  if (actual === expected) return actual;

  const actualParts = path.parse(actual);
  const expectedParts = path.parse(expected);
  if (actualParts.dir !== expectedParts.dir) return undefined;
  if (actualParts.ext !== expectedParts.ext) return undefined;
  if (!actualParts.name.startsWith(`${expectedParts.name}_`)) return undefined;

  return actual;
}

function appendWarnings(text, warnings) {
  if (warnings.length === 0) return text;
  return `${text}\n\n${warnings.join('\n')}`;
}

// Pick the backend request id from the response headers, if the gateway sends one.
function extractRequestId(headers) {
  for (const key of ['x-request-id', 'x-trace-id', 'x-msh-request-id', 'x-msh-trace-id', 'request-id']) {
    const value = headers.get(key);
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

// Append a trace line so failures can be correlated with backend logs. The
// tool-call-id is the `X-Msh-Tool-Call-Id` header we send on every request.
function appendTrace(text, trace) {
  if (trace === undefined || trace.toolCallId === undefined) return text;
  const parts = [];
  if (trace.requestId !== undefined) parts.push(`request-id: ${trace.requestId}`);
  parts.push(`tool-call-id: ${trace.toolCallId}`);
  return `${text}\n\n[kimi-datasource] ${parts.join(' · ')}`;
}

function resolveKimiHome(host) {
  const explicit = host.env.KIMI_CODE_HOME?.trim();
  return explicit && explicit.length > 0 ? explicit : path.join(host.os.homedir(), '.kimi-code');
}

function datasourceApiUrl(host) {
  const explicit = host.env.KIMI_DATASOURCE_API_URL?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return `${kimiCodeBaseUrl(host)}/tools`;
}

function kimiCodeBaseUrl(host) {
  return (host.env.KIMI_CODE_BASE_URL ?? DEFAULT_KIMI_CODE_BASE_URL).replace(/\/+$/, '');
}

function kimiCodeOAuthHost(host) {
  return normalizeEndpoint(
    host.env.KIMI_CODE_OAUTH_HOST ??
      host.env.KIMI_OAUTH_HOST ??
      DEFAULT_KIMI_CODE_OAUTH_HOST,
  );
}

function normalizeEndpoint(value) {
  return value.trim().replace(/\/+$/, '');
}

function resolveKimiCodeCredentialName(host) {
  const oauthHost = kimiCodeOAuthHost(host);
  const baseUrl = kimiCodeBaseUrl(host);
  if (
    oauthHost === normalizeEndpoint(DEFAULT_KIMI_CODE_OAUTH_HOST) &&
    baseUrl === DEFAULT_KIMI_CODE_BASE_URL
  ) {
    return 'kimi-code';
  }

  // Keep this in sync with packages/oauth/src/managed-kimi-code.ts.
  const digest = createHash('sha256')
    .update(JSON.stringify({ oauthHost, baseUrl }))
    .digest('hex')
    .slice(0, 16);
  return `kimi-code-env-${digest}`;
}

async function loadAccessToken(host) {
  const kimiHome = resolveKimiHome(host);
  const credentialsFile = path.join(
    kimiHome,
    'credentials',
    `${resolveKimiCodeCredentialName(host)}.json`,
  );
  let parsed;
  try {
    parsed = JSON.parse(await readFile(credentialsFile, 'utf8'));
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(
        `Kimi Code credentials file not found: ${credentialsFile}\nRun /login in Kimi Code first.`,
      );
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse Kimi Code credentials file: ${error.message}`);
    }
    throw error;
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid Kimi Code credentials file: ${credentialsFile}`);
  }
  const token = typeof parsed.access_token === 'string' ? parsed.access_token : '';
  if (token.length === 0) {
    throw new Error('Kimi Code credentials do not contain access_token. Run /login again.');
  }
  return { kimiHome, token };
}

async function callKimiTool(host, method, params, trace = {}) {
  const { kimiHome, token: initialToken } = await loadAccessToken(host);
  let token = initialToken;
  const toolCallId = host.uuid();
  trace.toolCallId = toolCallId;
  const controller = new AbortController();
  const timeout = host.setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const request = async (accessToken) => {
      const response = await host.fetch(datasourceApiUrl(host), {
        method: 'POST',
        headers: await buildHeaders(host, kimiHome, accessToken, toolCallId),
        body: JSON.stringify({ method, params }),
        signal: controller.signal,
      });
      return { response, text: await response.text() };
    };

    let { response, text } = await request(token);
    if (response.status === 401) {
      const refreshed = await loadAccessToken(host);
      if (refreshed.token !== token) {
        token = refreshed.token;
        ({ response, text } = await request(token));
      }
    }
    trace.requestId = extractRequestId(response.headers);
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Kimi Code access_token was rejected. Run /login again and retry.');
      }
      throw new Error(`HTTP ${response.status} error: ${text}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    }
    throw error;
  } finally {
    host.clearTimeout(timeout);
  }
}

async function buildHeaders(host, kimiHome, token, toolCallId) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Msh-Tool-Call-Id': toolCallId,
    'X-Msh-Platform': asciiHeader(host.env.KIMI_MSH_PLATFORM ?? 'kimi-code-cli'),
    'X-Msh-Version': asciiHeader(host.env.KIMI_MSH_VERSION ?? VERSION),
    'X-Msh-Device-Name': asciiHeader(host.env.KIMI_MSH_DEVICE_NAME ?? host.os.hostname()),
    'X-Msh-Device-Model': asciiHeader(host.env.KIMI_MSH_DEVICE_MODEL ?? deviceModel(host)),
    'X-Msh-Os-Version': asciiHeader(host.env.KIMI_MSH_OS_VERSION ?? host.os.release()),
    'X-Msh-Device-Id': asciiHeader(host.env.KIMI_MSH_DEVICE_ID ?? (await createDeviceId(host, kimiHome))),
    'User-Agent': `kimi-datasource/${VERSION}`,
  };
}

async function createDeviceId(host, kimiHome) {
  const deviceIdPath = path.join(kimiHome, 'device_id');
  try {
    const existing = (await readFile(deviceIdPath, 'utf8')).trim();
    if (existing.length > 0) return existing;
  } catch {
    // Fall through to create a best-effort local device id.
  }

  const id = host.uuid();
  try {
    await mkdir(kimiHome, { recursive: true, mode: 0o700 });
    await writeFile(deviceIdPath, `${id}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Headers can still use the in-memory id if the file cannot be written.
  }
  return id;
}

function deviceModel(host) {
  const os = host.os.type();
  const osVersion = host.os.release();
  const osArch = host.os.arch();
  if (os === 'Darwin') return `macOS ${osVersion} ${osArch}`;
  if (os === 'Windows_NT') return `Windows ${osVersion} ${osArch}`;
  return `${os} ${osVersion} ${osArch}`.trim();
}

function extractText(response) {
  if (typeof response === 'string') return response;
  if (!isRecord(response)) return String(response);

  if (response.is_success === false) {
    const message = extractChannelText(response.error) ?? JSON.stringify(response);
    throw new Error(`Tool API returned an error: ${message}`);
  }

  const text = extractChannelText(response.result);
  if (text !== undefined) return text;
  return `Tool API succeeded but did not return user text. Raw response: ${JSON.stringify(response)}`;
}

function extractChannelText(value) {
  if (!isRecord(value)) return undefined;
  for (const channel of ['assistant', 'user']) {
    const items = value[channel];
    if (!Array.isArray(items)) continue;
    const text = items
      .filter((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

function requiredString(args, field) {
  const value = optionalString(args, field);
  if (value === undefined) throw new Error(`Missing required argument: ${field}.`);
  return value;
}

function optionalString(args, field) {
  if (!isRecord(args)) return undefined;
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requiredObject(args, field) {
  if (!isRecord(args)) throw new Error(`Missing required argument: ${field}.`);
  const value = args[field];
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  return value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(err) {
  return isRecord(err) && err.code === 'ENOENT';
}

function asciiHeader(value, fallback = 'unknown') {
  const cleaned = String(value).replaceAll(/[^ -~]/g, '').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function jsonRpcError(code, message, data) {
  const err = new Error(message);
  err.jsonRpc = { code, message, data };
  return err;
}

function send(host, message) {
  host.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(host, id, result) {
  send(host, { jsonrpc: '2.0', id, result });
}

function sendError(host, id, error) {
  send(host, { jsonrpc: '2.0', id, error });
}

async function dispatch(host, message) {
  if (message?.jsonrpc !== '2.0') return;
  // Notifications carry no id and never expect a response.
  if (message.id === undefined || message.id === null) {
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
      return;
    }
    return;
  }
  const id = message.id;
  try {
    const result = await handleRequest(host, message);
    sendResult(host, id, result ?? {});
  } catch (error) {
    if (error && typeof error === 'object' && error.jsonRpc !== undefined) {
      sendError(host, id, error.jsonRpc);
      return;
    }
    sendError(host, id, {
      code: -32603,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function start(host = createHost()) {
  const rl = readline.createInterface({ input: host.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      sendError(host, null, {
        code: -32700,
        message: `Parse error: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    void dispatch(host, message);
  });
  rl.on('close', () => {
    host.exit(0);
  });
  return rl;
}

function invokedAsScript() {
  const scriptPath = process.argv[1];
  if (typeof scriptPath !== 'string' || scriptPath.length === 0) return false;
  const entryPath = fileURLToPath(import.meta.url);
  const invokedPath = path.resolve(scriptPath);
  if (process.platform === 'win32') {
    return entryPath.toLowerCase() === invokedPath.toLowerCase();
  }
  return entryPath === invokedPath;
}

if (invokedAsScript()) start();
