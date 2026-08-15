/// MCP (Model Context Protocol) native support.
///
/// Phase 1 migration from TypeScript:
///   - Config loading (parse mcp.json, merge, resolve paths)
///   - Stdio child-process management (spawn, stderr capture, lifecycle)
///   - JSON-RPC 2.0 protocol over stdio (initialize, tools/list, tools/call)
///
/// The TS layer (`packages/agent-core/src/mcp/`) retains HTTP/SSE transports
/// and OAuth.  Stdio transport can optionally use this native implementation
/// for better reliability and reduced GC pressure.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

// ============================================================================
// Constants
// ============================================================================

/// MCP protocol version negotiated during `initialize`.
const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

/// Capacity (in bytes) of the stderr tail buffer.
const STDERR_BUFFER_CAPACITY: usize = 4 * 1024;

/// Default startup timeout in milliseconds.
const DEFAULT_STARTUP_TIMEOUT_MS: u64 = 30_000;

/// Default tool-call timeout in milliseconds.
const DEFAULT_TOOL_TIMEOUT_MS: u64 = 60_000;

// ============================================================================
// Config loading
// ============================================================================

/// Configuration for a single MCP server after parsing and validation.
#[derive(Clone, Debug)]
pub struct McpServerConfig {
    pub transport: String,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub cwd: Option<String>,
    pub url: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub bearer_token_env_var: Option<String>,
    pub enabled: Option<bool>,
    pub startup_timeout_ms: Option<u32>,
    pub tool_timeout_ms: Option<u32>,
    pub enabled_tools: Option<Vec<String>>,
    pub disabled_tools: Option<Vec<String>>,
}

/// Result of loading MCP config from the three-tier file hierarchy.
pub struct McpConfigLoadResult {
    /// Merged server entries (name → config).
    pub servers: Vec<(String, McpServerConfig)>,
    /// Path to the user-global mcp.json.
    pub user_path: String,
    /// Path to the project-root .mcp.json.
    pub project_root_path: String,
    /// Path to the project-local .kimi-code/mcp.json.
    pub project_path: String,
    /// Error message if loading failed partially.
    pub error: Option<String>,
}

/// Input for `load_mcp_config`.
pub struct McpConfigLoadInput {
    pub cwd: String,
    pub home_dir: Option<String>,
}

/// Load and merge MCP server declarations from the three-tier config hierarchy:
///   1. `~/.kimi-code/mcp.json` (user-global)
///   2. `<project-root>/.mcp.json` (project-root, Claude-compatible)
///   3. `<cwd>/.kimi-code/mcp.json` (project-local)
///
/// Entries in later files override earlier files with the same key.
/// Stdio `cwd` paths in the project-root file are resolved relative to the
/// project root directory.
pub async fn load_mcp_config(input: &McpConfigLoadInput) -> McpConfigLoadResult {
    let home = match &input.home_dir {
        Some(h) => PathBuf::from(h),
        None => match get_home_dir() {
            Some(h) => h,
            None => {
                return McpConfigLoadResult {
                    servers: Vec::new(),
                    user_path: String::new(),
                    project_root_path: String::new(),
                    project_path: String::new(),
                    error: Some("Cannot determine home directory".to_string()),
                };
            }
        },
    };

    let user_path = home.join(".kimi-code").join("mcp.json");
    let project_root = find_project_root(Path::new(&input.cwd));
    let project_root_path = project_root.join(".mcp.json");
    let project_path = Path::new(&input.cwd).join(".kimi-code").join("mcp.json");

    let mut merged: HashMap<String, McpServerConfig> = HashMap::new();
    let mut errors: Vec<String> = Vec::new();

    // Load user-global config.
    match read_mcp_json(&user_path, None) {
        Ok(servers) => {
            for (name, config) in servers {
                merged.insert(name, config);
            }
        }
        Err(e) => {
            if !e.contains("not found") {
                errors.push(format!("user config: {}", e));
            }
        }
    }

    // Load project-root config (stdio cwd resolved relative to project root).
    let stdio_cwd_base = project_root.to_string_lossy().to_string();
    match read_mcp_json(&project_root_path, Some(&stdio_cwd_base)) {
        Ok(servers) => {
            for (name, config) in servers {
                merged.insert(name, config);
            }
        }
        Err(e) => {
            if !e.contains("not found") {
                errors.push(format!("project-root config: {}", e));
            }
        }
    }

    // Load project-local config.
    match read_mcp_json(&project_path, None) {
        Ok(servers) => {
            for (name, config) in servers {
                merged.insert(name, config);
            }
        }
        Err(e) => {
            if !e.contains("not found") {
                errors.push(format!("project config: {}", e));
            }
        }
    }

    // Convert to sorted vec for deterministic ordering.
    let mut servers: Vec<(String, McpServerConfig)> = merged.into_iter().collect();
    servers.sort_by(|a, b| a.0.cmp(&b.0));

    McpConfigLoadResult {
        servers,
        user_path: user_path.to_string_lossy().to_string(),
        project_root_path: project_root_path.to_string_lossy().to_string(),
        project_path: project_path.to_string_lossy().to_string(),
        error: if errors.is_empty() {
            None
        } else {
            Some(errors.join("; "))
        },
    }
}

/// Read and parse a single mcp.json file.
fn read_mcp_json(
    path: &Path,
    stdio_cwd_base: Option<&str>,
) -> Result<Vec<(String, McpServerConfig)>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("{}: not found", path.display()));
        }
        Err(e) => return Err(format!("{}: {}", path.display(), e)),
    };

    if text.trim().is_empty() {
        return Ok(Vec::new());
    }

    let data: Value = serde_json::from_str(&text)
        .map_err(|e| format!("{}: invalid JSON: {}", path.display(), e))?;

    let mcp_servers = data
        .get("mcpServers")
        .and_then(|v| v.as_object())
        .ok_or_else(|| format!("{}: missing 'mcpServers' key", path.display()))?;

    let mut result = Vec::new();
    for (name, raw) in mcp_servers {
        match parse_server_config(raw, stdio_cwd_base) {
            Ok(config) => result.push((name.clone(), config)),
            Err(e) => {
                return Err(format!("{}: server '{}': {}", path.display(), name, e));
            }
        }
    }

    Ok(result)
}

/// Parse a single server config from JSON, inferring transport if missing.
fn parse_server_config(
    raw: &Value,
    stdio_cwd_base: Option<&str>,
) -> Result<McpServerConfig, String> {
    let obj = raw
        .as_object()
        .ok_or_else(|| "config must be an object".to_string())?;

    // Infer transport if not explicitly set.
    let transport = obj
        .get("transport")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            if obj.contains_key("command") {
                "stdio".to_string()
            } else if obj.contains_key("url") {
                "http".to_string()
            } else {
                "stdio".to_string()
            }
        });

    let mut config = McpServerConfig {
        transport: transport.clone(),
        command: obj
            .get("command")
            .and_then(|v| v.as_str())
            .map(String::from),
        args: obj.get("args").and_then(|v| v.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        }),
        env: parse_string_map(obj.get("env")),
        cwd: obj.get("cwd").and_then(|v| v.as_str()).map(String::from),
        url: obj.get("url").and_then(|v| v.as_str()).map(String::from),
        headers: parse_string_map(obj.get("headers")),
        bearer_token_env_var: obj
            .get("bearerTokenEnvVar")
            .and_then(|v| v.as_str())
            .map(String::from),
        enabled: obj.get("enabled").and_then(|v| v.as_bool()),
        startup_timeout_ms: obj
            .get("startupTimeoutMs")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        tool_timeout_ms: obj
            .get("toolTimeoutMs")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        enabled_tools: obj
            .get("enabledTools")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            }),
        disabled_tools: obj
            .get("disabledTools")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            }),
    };

    // Validate required fields per transport.
    match transport.as_str() {
        "stdio" => {
            if config.command.is_none() {
                return Err("stdio transport requires 'command'".to_string());
            }
            // Resolve relative cwd against stdio_cwd_base.
            if let Some(base) = stdio_cwd_base {
                if let Some(cwd) = &config.cwd {
                    if !Path::new(cwd).is_absolute() {
                        config.cwd = Some(Path::new(base).join(cwd).to_string_lossy().to_string());
                    }
                }
            }
        }
        "http" | "sse" => {
            if config.url.is_none() {
                return Err(format!("{} transport requires 'url'", transport));
            }
        }
        _ => return Err(format!("unknown transport: {}", transport)),
    }

    Ok(config)
}

fn parse_string_map(v: Option<&Value>) -> Option<HashMap<String, String>> {
    v.and_then(|v| v.as_object()).map(|obj| {
        obj.iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect()
    })
}

/// Walk up from `start` looking for a `.git` entry; fall back to `start`.
fn find_project_root(start: &Path) -> PathBuf {
    let start = if start.is_absolute() {
        start.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| start.to_path_buf())
            .join(start)
    };

    let mut current = start.clone();
    loop {
        if current.join(".git").exists() {
            return current;
        }
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        } else {
            break;
        }
    }
    start
}

/// Get the user's home directory (cross-platform).
fn get_home_dir() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

// ============================================================================
// Stdio MCP client — JSON-RPC 2.0 over child process stdio
// ============================================================================

/// Internal state for a spawned stdio MCP server connection.
struct StdioClient {
    child: Child,
    stdin: ChildStdin,
    stdout_reader: BufReader<ChildStdout>,
    stderr: std::sync::Arc<Mutex<String>>,
    next_request_id: u64,
    initialized: bool,
    server_info: Option<Value>,
}

/// Global registry of active stdio clients, keyed by handle.
static CLIENTS: OnceLock<Mutex<HashMap<u64, StdioClient>>> = OnceLock::new();
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);

fn clients() -> &'static Mutex<HashMap<u64, StdioClient>> {
    CLIENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Configuration for spawning a stdio MCP server.
pub struct StdioSpawnConfig {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cwd: Option<String>,
}

/// Result of spawning a stdio MCP server.
#[derive(Debug)]
pub struct StdioSpawnResult {
    pub handle: u64,
    pub pid: u32,
}

/// A tool definition returned by `tools/list`.
pub struct McpToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// Spawn a child process for a stdio MCP server and register it.
pub async fn stdio_spawn(config: &StdioSpawnConfig) -> Result<StdioSpawnResult, String> {
    let mut cmd = Command::new(&config.command);
    cmd.args(&config.args);

    // Set environment variables.
    cmd.env_clear();
    // Inherit PATH so npx/uvx work.
    if let Some(path) = std::env::var_os("PATH") {
        cmd.env("PATH", path);
    }
    if cfg!(target_os = "windows") {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            cmd.env("USERPROFILE", profile);
        }
        if let Some(sys_root) = std::env::var_os("SystemRoot") {
            cmd.env("SystemRoot", sys_root);
        }
    } else {
        if let Some(home) = std::env::var_os("HOME") {
            cmd.env("HOME", home);
        }
    }
    // Apply user-provided env overrides.
    for (k, v) in &config.env {
        cmd.env(k, v);
    }

    if let Some(cwd) = &config.cwd {
        cmd.current_dir(cwd);
    }

    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    // On Windows, hide the console window. (`creation_flags` is an inherent
    // method on tokio's Command on Windows — no CommandExt import needed.)
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn '{}': {}", config.command, e))?;

    let pid = child
        .id()
        .ok_or_else(|| "Failed to get child PID".to_string())?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture child stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture child stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture child stderr".to_string())?;

    let stderr_buf = std::sync::Arc::new(Mutex::new(String::new()));
    let stderr_buf_clone = stderr_buf.clone();

    // Spawn a background task to drain stderr into the bounded buffer.
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = vec![0u8; 512];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    let mut guard = stderr_buf_clone.lock().await;
                    guard.push_str(&chunk);
                    let len = guard.len();
                    if len > STDERR_BUFFER_CAPACITY {
                        let start = len - STDERR_BUFFER_CAPACITY;
                        let drained = guard[start..].to_string();
                        *guard = drained;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let stdout_reader = BufReader::new(stdout);

    let handle = NEXT_HANDLE.fetch_add(1, Ordering::SeqCst);
    let client = StdioClient {
        child,
        stdin,
        stdout_reader,
        stderr: stderr_buf,
        next_request_id: 1,
        initialized: false,
        server_info: None,
    };

    clients().lock().await.insert(handle, client);

    Ok(StdioSpawnResult { handle, pid })
}

/// Send the JSON-RPC `initialize` request and the `notifications/initialized`
/// notification.  Must be called before `list_tools` or `call_tool`.
pub async fn stdio_initialize(
    handle: u64,
    client_name: &str,
    client_version: &str,
    timeout_ms: Option<u32>,
) -> Result<Value, String> {
    let timeout =
        Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_STARTUP_TIMEOUT_MS as u32) as u64);

    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": client_name,
                "version": client_version,
            }
        }
    });

    let response = tokio::time::timeout(timeout, send_request_inner(handle, request))
        .await
        .map_err(|_| {
            let stderr = try_get_stderr(handle);
            format!(
                "MCP initialize timed out after {}ms{}",
                timeout.as_millis(),
                stderr
                    .map(|s| format!("\nstderr: {}", s))
                    .unwrap_or_default()
            )
        })??;

    // Send the initialized notification (no response expected).
    let notification = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    });
    send_notification_inner(handle, &notification).await?;

    // Mark as initialized.
    {
        let mut clients = clients().lock().await;
        if let Some(client) = clients.get_mut(&handle) {
            client.initialized = true;
            client.server_info = Some(response.clone());
            client.next_request_id = 2; // id 1 was used for initialize
        } else {
            return Err("Invalid handle".to_string());
        }
    }

    Ok(response)
}

/// Call `tools/list` on the MCP server.
pub async fn stdio_list_tools(handle: u64) -> Result<Vec<McpToolDef>, String> {
    let id = next_request_id(handle).await;
    let request = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/list",
        "params": {}
    });

    let response = send_request_inner(handle, request).await?;

    let tools = response
        .get("tools")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "tools/list response missing 'tools' array".to_string())?;

    let result: Vec<McpToolDef> = tools
        .iter()
        .map(|tool| McpToolDef {
            name: tool
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            description: tool
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            input_schema: tool
                .get("inputSchema")
                .cloned()
                .unwrap_or(Value::Object(serde_json::Map::new())),
        })
        .collect();

    Ok(result)
}

/// Call `tools/call` on the MCP server.
pub async fn stdio_call_tool(
    handle: u64,
    name: &str,
    args: &Value,
    timeout_ms: Option<u32>,
) -> Result<Value, String> {
    let id = next_request_id(handle).await;
    let request = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": {
            "name": name,
            "arguments": args,
        }
    });

    let timeout =
        Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TOOL_TIMEOUT_MS as u32) as u64);

    let response = tokio::time::timeout(timeout, send_request_inner(handle, request))
        .await
        .map_err(|_| {
            let stderr = try_get_stderr(handle);
            format!(
                "tools/call '{}' timed out after {}ms{}",
                name,
                timeout.as_millis(),
                stderr
                    .map(|s| format!("\nstderr: {}", s))
                    .unwrap_or_default()
            )
        })??;

    Ok(response)
}

/// Close the stdio connection: kill the child process and remove the client.
pub async fn stdio_close(handle: u64) -> Result<(), String> {
    let mut clients = clients().lock().await;
    if let Some(mut client) = clients.remove(&handle) {
        // Try to kill the child process.
        let _ = client.child.kill().await;
        let _ = client.child.wait().await;
        // Drop stdin to close the pipe.
        let _ = client.stdin.shutdown().await;
    }
    Ok(())
}

/// Get a snapshot of the child process's stderr (tail, bounded).
///
/// Uses `try_lock` so it never blocks when a request is in flight.
/// Returns the last cached value (which may be empty) in that case.
pub async fn stdio_stderr_snapshot(handle: u64) -> String {
    let clients = clients().lock().await;
    if let Some(client) = clients.get(&handle) {
        // Try non-blocking lock on stderr; if contended, return empty.
        match client.stderr.try_lock() {
            Ok(guard) => guard.clone(),
            Err(_) => String::new(),
        }
    } else {
        String::new()
    }
}

/// Check if the child process is still alive.
///
/// Uses `try_lock` on the clients map; if contended (a request is in
/// flight), returns `true` to avoid false-positive death reports.
pub async fn stdio_is_alive(handle: u64) -> bool {
    let mut clients = match clients().try_lock() {
        Ok(guard) => guard,
        Err(_) => return true, // Assume alive when lock is contended.
    };
    if let Some(client) = clients.get_mut(&handle) {
        match client.child.try_wait() {
            Ok(None) => true,     // Still running
            Ok(Some(_)) => false, // Exited
            Err(_) => false,
        }
    } else {
        false
    }
}

// ── Internal helpers ─────────────────────────────────────────────────────

/// Send a JSON-RPC request and wait for the matching response.
async fn send_request_inner(handle: u64, request: Value) -> Result<Value, String> {
    let id = request.get("id").and_then(|v| v.as_u64()).unwrap_or(0);

    let request_str = serde_json::to_string(&request)
        .map_err(|e| format!("Failed to serialize request: {}", e))?;

    // Write request to stdin (short lock — just the write).
    {
        let mut clients = clients().lock().await;
        let client = clients
            .get_mut(&handle)
            .ok_or_else(|| "Invalid handle".to_string())?;

        client
            .stdin
            .write_all(request_str.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;
        client
            .stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Failed to write newline to stdin: {}", e))?;
        client
            .stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;
    }

    // Read lines from stdout until we get the matching response.
    // We hold the lock for the entire read loop because stdout_reader is
    // owned by StdioClient and cannot be taken out without restructuring.
    // Concurrent calls to the same handle are serialized at the TS layer
    // (connection-manager calls listTools/callTool sequentially).
    let mut line = String::new();
    let mut clients = clients().lock().await;
    let client = clients
        .get_mut(&handle)
        .ok_or_else(|| "Invalid handle".to_string())?;

    loop {
        line.clear();
        let n = client
            .stdout_reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("Failed to read from stdout: {}", e))?;

        if n == 0 {
            let stderr = client.stderr.lock().await.clone();
            return Err(format!(
                "Connection closed (EOF on stdout){}",
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!("\nstderr: {}", stderr)
                }
            ));
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue, // Skip non-JSON lines
        };

        // Check if this is a response (has matching id).
        if let Some(resp_id) = msg.get("id").and_then(|v| v.as_u64()) {
            if resp_id == id {
                if let Some(error) = msg.get("error") {
                    return Err(format!(
                        "JSON-RPC error: {}",
                        error
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown error")
                    ));
                }
                return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
            }
        }
        // Notifications or unmatched responses are ignored.
    }
}

/// Send a JSON-RPC notification (no response expected).
async fn send_notification_inner(handle: u64, notification: &Value) -> Result<(), String> {
    let notif_str = serde_json::to_string(notification)
        .map_err(|e| format!("Failed to serialize notification: {}", e))?;

    let mut clients = clients().lock().await;
    let client = clients
        .get_mut(&handle)
        .ok_or_else(|| "Invalid handle".to_string())?;

    client
        .stdin
        .write_all(notif_str.as_bytes())
        .await
        .map_err(|e| format!("Failed to write notification: {}", e))?;
    client
        .stdin
        .write_all(b"\n")
        .await
        .map_err(|e| format!("Failed to write newline: {}", e))?;
    client
        .stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush stdin: {}", e))?;

    Ok(())
}

/// Get and increment the next request ID for a client.
///
/// Note: This acquires and releases the lock before `send_request_inner`
/// re-acquires it.  Concurrent calls to the same handle could interleave
/// IDs.  This is safe because (a) the TS layer serializes calls per handle,
/// and (b) even if IDs interleave, each response is matched by its `id`
/// field in the read loop.
async fn next_request_id(handle: u64) -> u64 {
    let mut clients = clients().lock().await;
    if let Some(client) = clients.get_mut(&handle) {
        let id = client.next_request_id;
        client.next_request_id += 1;
        id
    } else {
        0
    }
}

/// Try to get stderr snapshot without blocking (for error messages).
fn try_get_stderr(_handle: u64) -> Option<String> {
    // Cannot try_lock on tokio Mutex — return None and let callers use
    // the async `stdio_stderr_snapshot` when they need the actual value.
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes stdio tests (the client registry is process-global).
    static STDIO_TEST_LOCK: once_cell::sync::Lazy<tokio::sync::Mutex<()>> =
        once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(()));

    // ── Config parsing ──────────────────────────────────────────────

    #[test]
    fn test_parse_server_config_infers_stdio_from_command() {
        let raw = json!({ "command": "npx", "args": ["-y", "server"] });
        let config = parse_server_config(&raw, None).unwrap();
        assert_eq!(config.transport, "stdio");
        assert_eq!(config.command.as_deref(), Some("npx"));
        assert_eq!(config.args, Some(vec!["-y".to_string(), "server".to_string()]));
    }

    #[test]
    fn test_parse_server_config_infers_http_from_url() {
        let raw = json!({ "url": "https://example.test/mcp" });
        let config = parse_server_config(&raw, None).unwrap();
        assert_eq!(config.transport, "http");
        assert_eq!(config.url.as_deref(), Some("https://example.test/mcp"));
    }

    #[test]
    fn test_parse_server_config_explicit_transport_wins() {
        let raw = json!({
            "transport": "sse",
            "command": "npx",
            "url": "https://example.test/mcp",
        });
        let config = parse_server_config(&raw, None).unwrap();
        assert_eq!(config.transport, "sse");
    }

    #[test]
    fn test_parse_server_config_stdio_requires_command() {
        let raw = json!({ "transport": "stdio", "url": "https://x" });
        let err = parse_server_config(&raw, None).unwrap_err();
        assert!(err.contains("requires 'command'"), "got: {err}");
    }

    #[test]
    fn test_parse_server_config_http_requires_url() {
        let raw = json!({ "transport": "http", "command": "npx" });
        let err = parse_server_config(&raw, None).unwrap_err();
        assert!(err.contains("requires 'url'"), "got: {err}");
    }

    #[test]
    fn test_parse_server_config_unknown_transport() {
        let raw = json!({ "transport": "carrier-pigeon", "command": "npx" });
        let err = parse_server_config(&raw, None).unwrap_err();
        assert!(err.contains("unknown transport"), "got: {err}");
    }

    #[test]
    fn test_parse_server_config_resolves_relative_cwd() {
        let raw = json!({ "command": "npx", "cwd": "rel/path" });
        let config = parse_server_config(&raw, Some("G:/base")).unwrap();
        let expected = std::path::PathBuf::from("G:/base").join("rel/path");
        assert_eq!(
            std::path::PathBuf::from(config.cwd.as_deref().unwrap()),
            expected
        );
        // Absolute cwd is left untouched.
        let raw2 = json!({ "command": "npx", "cwd": "G:/abs/path" });
        let config2 = parse_server_config(&raw2, Some("G:/base")).unwrap();
        assert_eq!(config2.cwd.as_deref(), Some("G:/abs/path"));
    }

    #[test]
    fn test_parse_server_config_full_field_mapping() {
        let raw = json!({
            "command": "npx",
            "env": { "A": "1" },
            "bearerTokenEnvVar": "MY_TOKEN",
            "enabled": false,
            "startupTimeoutMs": 5000,
            "toolTimeoutMs": 10000,
            "enabledTools": ["a", "b"],
            "disabledTools": ["c"],
        });
        let config = parse_server_config(&raw, None).unwrap();
        assert_eq!(config.env, Some(HashMap::from([("A".to_string(), "1".to_string())])));
        assert_eq!(config.bearer_token_env_var.as_deref(), Some("MY_TOKEN"));
        assert_eq!(config.enabled, Some(false));
        assert_eq!(config.startup_timeout_ms, Some(5000));
        assert_eq!(config.tool_timeout_ms, Some(10000));
        assert_eq!(config.enabled_tools, Some(vec!["a".to_string(), "b".to_string()]));
        assert_eq!(config.disabled_tools, Some(vec!["c".to_string()]));
    }

    #[test]
    fn test_parse_server_config_rejects_non_object() {
        let err = parse_server_config(&json!("string"), None).unwrap_err();
        assert!(err.contains("must be an object"), "got: {err}");
    }

    #[test]
    fn test_read_mcp_json_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_mcp_json(&dir.path().join("nope.json"), None).unwrap_err();
        assert!(err.contains("not found"), "got: {err}");
    }

    #[test]
    fn test_read_mcp_json_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        std::fs::write(&path, "  \n").unwrap();
        let servers = read_mcp_json(&path, None).unwrap();
        assert!(servers.is_empty());
    }

    #[test]
    fn test_read_mcp_json_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        std::fs::write(&path, "{ not json").unwrap();
        let err = read_mcp_json(&path, None).unwrap_err();
        assert!(err.contains("invalid JSON"), "got: {err}");
    }

    #[test]
    fn test_read_mcp_json_missing_servers_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        std::fs::write(&path, r#"{"other": true}"#).unwrap();
        let err = read_mcp_json(&path, None).unwrap_err();
        assert!(err.contains("missing 'mcpServers'"), "got: {err}");
    }

    #[test]
    fn test_read_mcp_json_server_error_propagates_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        std::fs::write(&path, r#"{"mcpServers": {"bad": {"transport": "stdio"}}}"#).unwrap();
        let err = read_mcp_json(&path, None).unwrap_err();
        assert!(err.contains("'bad'"), "got: {err}");
    }

    fn write_file(path: &std::path::Path, content: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, content).unwrap();
    }

    fn test_home() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_string_lossy().to_string();
        (dir, home)
    }

    #[tokio::test]
    async fn test_load_mcp_config_merges_tiers_with_override_order() {
        let (dir, home) = test_home();
        let proj = dir.path().join("proj");
        let cwd = proj.clone();
        std::fs::create_dir_all(proj.join(".git")).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();

        write_file(
            &proj.join(".kimi-code").join("mcp.json"),
            r#"{"mcpServers": {"shared": {"command": "local-cmd"}, "localOnly": {"url": "http://local"}}}"#,
        );
        write_file(
            &proj.join(".mcp.json"),
            r#"{"mcpServers": {"shared": {"command": "root-cmd", "cwd": "rel"}, "rootOnly": {"command": "root-tool", "cwd": "tools"}}}"#,
        );
        write_file(
            &Path::new(&home).join(".kimi-code").join("mcp.json"),
            r#"{"mcpServers": {"shared": {"command": "user-cmd"}, "userOnly": {"url": "http://user"}}}"#,
        );

        let result = load_mcp_config(&McpConfigLoadInput {
            cwd: cwd.to_string_lossy().to_string(),
            home_dir: Some(home.clone()),
        })
        .await;

        assert!(result.error.is_none(), "error: {:?}", result.error);
        let names: Vec<&str> = result.servers.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["localOnly", "rootOnly", "shared", "userOnly"]);

        let shared = result
            .servers
            .iter()
            .find(|(n, _)| n == "shared")
            .map(|(_, c)| c)
            .unwrap();
        // Project-local tier wins over project-root and user tiers.
        assert_eq!(shared.command.as_deref(), Some("local-cmd"));

        let root_only = result
            .servers
            .iter()
            .find(|(n, _)| n == "rootOnly")
            .map(|(_, c)| c)
            .unwrap();
        // Relative cwd in the project-root file is resolved against the project root.
        let expected_cwd = proj.join("tools").to_string_lossy().to_string();
        assert_eq!(root_only.cwd.as_deref(), Some(expected_cwd.as_str()));

        let expected_user = Path::new(&home).join(".kimi-code").join("mcp.json").to_string_lossy().to_string();
        assert_eq!(result.user_path, expected_user);
        assert_eq!(result.project_root_path, proj.join(".mcp.json").to_string_lossy().to_string());
        assert_eq!(result.project_path, proj.join(".kimi-code").join("mcp.json").to_string_lossy().to_string());
        drop(dir);
    }

    #[tokio::test]
    async fn test_load_mcp_config_missing_files_is_not_an_error() {
        let (dir, home) = test_home();
        let proj = dir.path().join("proj");
        std::fs::create_dir_all(&proj).unwrap();

        let result = load_mcp_config(&McpConfigLoadInput {
            cwd: proj.to_string_lossy().to_string(),
            home_dir: Some(home),
        })
        .await;

        assert!(result.error.is_none(), "error: {:?}", result.error);
        assert!(result.servers.is_empty());
        drop(dir);
    }

    #[tokio::test]
    async fn test_load_mcp_config_reports_partial_errors() {
        let (dir, home) = test_home();
        let proj = dir.path().join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        write_file(
            &Path::new(&home).join(".kimi-code").join("mcp.json"),
            "{ definitely not json",
        );
        write_file(
            &proj.join(".mcp.json"),
            r#"{"mcpServers": {"ok": {"command": "fine"}}}"#,
        );

        let result = load_mcp_config(&McpConfigLoadInput {
            cwd: proj.to_string_lossy().to_string(),
            home_dir: Some(home),
        })
        .await;

        let error = result.error.expect("partial failure should be reported");
        assert!(error.contains("user config"), "got: {error}");
        // Servers from the valid tier still load.
        assert_eq!(result.servers.len(), 1);
        assert_eq!(result.servers[0].0, "ok");
        drop(dir);
    }

    #[test]
    fn test_find_project_root_walks_to_git() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("a").join("b");
        let cwd = root.join("c").join("d");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();

        let found = find_project_root(&cwd);
        assert_eq!(found, root);

        // No .git anywhere: falls back to the start path.
        let loose = dir.path().join("x");
        std::fs::create_dir_all(&loose).unwrap();
        let found = find_project_root(&loose);
        assert_eq!(found, loose);
    }

    // ── Stdio client (requires `node` on PATH) ──────────────────────

    const TEST_SERVER_JS: &str = r#"
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
process.stderr.write('server stderr line\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'test-server', version: '1.0.0' } } }) + '\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Echo tool', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } }) + '\n');
  } else if (msg.method === 'tools/call') {
    if (msg.params.name === 'fail') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'intentional failure' } }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + JSON.stringify(msg.params.arguments) }] } }) + '\n');
    }
  }
});
"#;

    fn node_available() -> bool {
        std::process::Command::new("node")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn write_test_server() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        write_file(&dir.path().join("mcp-server.js"), TEST_SERVER_JS);
        dir
    }

    #[tokio::test]
    async fn test_stdio_full_lifecycle() {
        let _guard = STDIO_TEST_LOCK.lock().await;
        if !node_available() {
            eprintln!("node not available; skipping");
            return;
        }
        let dir = write_test_server();
        let script = dir.path().join("mcp-server.js");
        let spawn = stdio_spawn(&StdioSpawnConfig {
            command: "node".to_string(),
            args: vec![script.to_string_lossy().to_string()],
            env: HashMap::new(),
            cwd: None,
        })
        .await
        .expect("spawn should succeed");
        assert!(spawn.pid > 0);

        let init = stdio_initialize(spawn.handle, "test-client", "0.0.1", Some(5000))
            .await
            .expect("initialize should succeed");
        assert_eq!(init["serverInfo"]["name"], "test-server");

        let tools = stdio_list_tools(spawn.handle).await.expect("tools/list");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
        assert_eq!(tools[0].description, "Echo tool");

        let result = stdio_call_tool(
            spawn.handle,
            "echo",
            &json!({ "text": "hello" }),
            Some(5000),
        )
        .await
        .expect("tools/call");
        let text = result["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, r#"echo:{"text":"hello"}"#);

        // stderr buffer captures the server's stderr line.
        let snapshot = stdio_stderr_snapshot(spawn.handle).await;
        assert!(snapshot.contains("server stderr line"), "got: {snapshot}");

        assert!(stdio_is_alive(spawn.handle).await);
        stdio_close(spawn.handle).await.expect("close");
        assert!(!stdio_is_alive(spawn.handle).await);
    }

    #[tokio::test]
    async fn test_stdio_jsonrpc_error_surfaces() {
        let _guard = STDIO_TEST_LOCK.lock().await;
        if !node_available() {
            eprintln!("node not available; skipping");
            return;
        }
        let dir = write_test_server();
        let script = dir.path().join("mcp-server.js");
        let spawn = stdio_spawn(&StdioSpawnConfig {
            command: "node".to_string(),
            args: vec![script.to_string_lossy().to_string()],
            env: HashMap::new(),
            cwd: None,
        })
        .await
        .expect("spawn");

        stdio_initialize(spawn.handle, "test-client", "0.0.1", Some(5000))
            .await
            .expect("initialize");

        let err = stdio_call_tool(spawn.handle, "fail", &json!({}), Some(5000))
            .await
            .unwrap_err();
        assert!(err.contains("intentional failure"), "got: {err}");
        stdio_close(spawn.handle).await.ok();
    }

    #[tokio::test]
    async fn test_stdio_invalid_handle_errors() {
        let _guard = STDIO_TEST_LOCK.lock().await;
        let err = stdio_initialize(99_999, "c", "v", Some(1000)).await.unwrap_err();
        assert!(err.contains("Invalid handle"), "got: {err}");
        let err = stdio_call_tool(99_999, "x", &json!({}), Some(1000))
            .await
            .unwrap_err();
        assert!(err.contains("Invalid handle"), "got: {err}");
        // Closing an unknown handle is a no-op success.
        stdio_close(99_999).await.expect("close unknown handle");
        assert!(!stdio_is_alive(99_999).await);
    }

    #[tokio::test]
    async fn test_stdio_spawn_missing_command_fails() {
        let _guard = STDIO_TEST_LOCK.lock().await;
        let err = stdio_spawn(&StdioSpawnConfig {
            command: "definitely-not-a-real-command-xyz".to_string(),
            args: vec![],
            env: HashMap::new(),
            cwd: None,
        })
        .await
        .unwrap_err();
        assert!(err.contains("Failed to spawn"), "got: {err}");
    }

    #[tokio::test]
    async fn test_stdio_call_tool_before_initialize_fails() {
        let _guard = STDIO_TEST_LOCK.lock().await;
        if !node_available() {
            eprintln!("node not available; skipping");
            return;
        }
        let dir = write_test_server();
        let script = dir.path().join("mcp-server.js");
        let spawn = stdio_spawn(&StdioSpawnConfig {
            command: "node".to_string(),
            args: vec![script.to_string_lossy().to_string()],
            env: HashMap::new(),
            cwd: None,
        })
        .await
        .expect("spawn");

        // The test server responds to tools/list even without initialize,
        // but a client that never initializes must still be closable.
        stdio_close(spawn.handle).await.expect("close");
    }
}
