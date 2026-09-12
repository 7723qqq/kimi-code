//! Workflow JS sandbox and host primitives.
//!
//! Ported from the retired `agent-core-v2` `workflowRuntime.ts`. The script
//! runs in an embedded QuickJS context ([`rquickjs`]) as an async IIFE with a
//! fixed set of injected host functions — no `require`, `process`, or Node API.
//!
//! Host functions that cross an `.await` return JSON text to the JS prelude
//! (`JSON.parse`), never a `Ctx`-bound value: capturing a `Ctx` inside an async
//! native closure leaves a reference cycle QuickJS cannot collect, which trips
//! its `list_empty(&rt->gc_obj_list)` assertion when the runtime is freed.
//!
//! The embedded engine is behind the `workflow-js` feature. With it off the
//! pure-Rust helpers stay compiled (they are exercised through the sandbox) but
//! [`execute_workflow`] reports the engine is unavailable.

#![cfg_attr(not(feature = "workflow-js"), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
#[cfg(feature = "workflow-js")]
use rquickjs::function::Async;
#[cfg(feature = "workflow-js")]
use rquickjs::{
    Array, AsyncContext, AsyncRuntime, Ctx, Function, Object, Promise, Value as JsValue,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::RunState;

/// `agent()` options, matching the v2 `AgentOpts` shape.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct WorkflowAgentOpts {
    #[serde(rename = "agentType")]
    pub agent_type: Option<String>,
    pub model: Option<String>,
    pub schema: Option<Value>,
    pub label: Option<String>,
    pub phase: Option<String>,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// Host capabilities the sandbox cannot provide itself: subagent spawning and
/// web search. File IO / exec / fetch are implemented natively in this module.
#[async_trait]
pub trait WorkflowHost: Send + Sync {
    async fn spawn_agent(&self, prompt: String, opts: WorkflowAgentOpts) -> Option<Value>;
    async fn search(&self, query: String, count: usize) -> Vec<SearchHit>;
    fn workspace_root(&self) -> PathBuf;
    fn home_dir(&self) -> Option<PathBuf>;
}

const DEFAULT_DEADLINE_MS: u64 = 12 * 60 * 60 * 1000;
const CANCEL_POLL_MS: u64 = 50;

/// Execute a workflow script and return its (JSON) result.
///
/// Without the `workflow-js` feature there is no sandbox to run the script in;
/// the workflow tool surfaces this string as the failure reason.
pub(crate) async fn execute_workflow(
    script: &str,
    args: Option<Value>,
    host: Arc<dyn WorkflowHost>,
    run: Arc<RunState>,
) -> Result<Value, String> {
    #[cfg(feature = "workflow-js")]
    {
        execute_workflow_js(script, args, host, run).await
    }
    #[cfg(not(feature = "workflow-js"))]
    {
        let _ = (script, args, host, run);
        Err("the workflow JS engine is not compiled into this build".to_string())
    }
}

#[cfg(feature = "workflow-js")]
async fn execute_workflow_js(
    script: &str,
    args: Option<Value>,
    host: Arc<dyn WorkflowHost>,
    run: Arc<RunState>,
) -> Result<Value, String> {
    let runtime = AsyncRuntime::new().map_err(|error| error.to_string())?;
    let ctx = AsyncContext::full(&runtime)
        .await
        .map_err(|error| error.to_string())?;

    // `export` is module syntax the eval context rejects; the meta literal is
    // metadata only, so demote it to a plain const before running.
    let script = script.replace("export const meta", "const meta");
    let args_js = args.unwrap_or(Value::String(String::new()));

    let host_for_ctx = host.clone();
    let run_for_ctx = run.clone();

    let outcome = rquickjs::async_with!(ctx => |ctx| {
        install_globals(&ctx, host_for_ctx.clone(), run_for_ctx.clone(), &args_js)?;

        let wrapped = format!("(async () => {{\n{script}\n}})()");
        let promise: Promise = ctx.eval(wrapped)?;

        let cancelled = wait_for_cancel(run_for_ctx.clone());
        let deadline = tokio::time::sleep(Duration::from_millis(DEFAULT_DEADLINE_MS));
        let fut = promise.into_future::<JsValue>();

        let result = tokio::select! {
            result = fut => match result {
                Ok(value) => Ok(js_to_json(&value)),
                Err(error) => {
                    let caught = rquickjs::CaughtError::from_error(&ctx, error);
                    Err(rquickjs::Error::new_from_js_message(
                        "workflow", "workflow", caught.to_string(),
                    ))
                }
            },
            _ = cancelled => Err(rquickjs::Error::new_from_js_message(
                "workflow", "workflow", "workflow cancelled",
            )),
            _ = deadline => Err(rquickjs::Error::new_from_js_message(
                "workflow", "workflow", "workflow script deadline exceeded",
            )),
        };
        ctx.run_gc();
        result
    })
    .await;

    let _ = runtime.idle().await;
    drop(ctx);

    outcome.map_err(|error| error.to_string())
}

async fn wait_for_cancel(run: Arc<RunState>) {
    loop {
        if run.is_cancelled() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(CANCEL_POLL_MS)).await;
    }
}

fn json_string(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

#[cfg(feature = "workflow-js")]
fn install_globals<'js>(
    ctx: &Ctx<'js>,
    host: Arc<dyn WorkflowHost>,
    run: Arc<RunState>,
    args: &Value,
) -> rquickjs::Result<()> {
    let globals = ctx.globals();

    globals.set("args", json_to_js(ctx, args)?)?;

    {
        let run = run.clone();
        globals.set(
            "phase",
            Function::new(ctx.clone(), move |title: String| {
                run.set_phase(&title);
            })?,
        )?;
    }

    globals.set(
        "log",
        Function::new(ctx.clone(), move |message: String| {
            tracing::debug!(target: "workflow", "{message}");
        })?,
    )?;

    globals.set(
        "sleep",
        Function::new(
            ctx.clone(),
            Async(move |ms: f64| async move {
                let ms = if ms.is_finite() && ms > 0.0 {
                    ms as u64
                } else {
                    0
                };
                tokio::time::sleep(Duration::from_millis(ms)).await;
                Ok::<_, rquickjs::Error>(())
            }),
        )?,
    )?;

    // agent(prompt, optsJson) -> JSON text (or "null")
    {
        let host = host.clone();
        let run = run.clone();
        globals.set(
            "__native_agent",
            Function::new(
                ctx.clone(),
                Async(move |prompt: String, opts_json: String| {
                    let host = host.clone();
                    let run = run.clone();
                    async move {
                        if run.is_cancelled() {
                            return Ok::<String, rquickjs::Error>("null".to_string());
                        }
                        let opts = parse_opts(&opts_json);
                        run.record_agent();
                        Ok(match host.spawn_agent(prompt, opts).await {
                            Some(value) => json_string(&value),
                            None => "null".to_string(),
                        })
                    }
                }),
            )?,
        )?;
    }

    // search(query) -> JSON array text
    {
        let host = host.clone();
        globals.set(
            "__native_search",
            Function::new(
                ctx.clone(),
                Async(move |query: String| {
                    let host = host.clone();
                    async move {
                        let hits = host.search(query, 8).await;
                        let value = serde_json::to_value(&hits).unwrap_or(Value::Array(vec![]));
                        Ok::<String, rquickjs::Error>(json_string(&value))
                    }
                }),
            )?,
        )?;
    }

    // readFile / writeFile / glob / exists are all jailed to the workspace root.
    let root = host.workspace_root();

    {
        let root = root.clone();
        globals.set(
            "readFile",
            Function::new(
                ctx.clone(),
                Async(move |path: String| {
                    let root = root.clone();
                    async move {
                        let resolved = resolve_in_workspace(&root, &path).map_err(|message| {
                            rquickjs::Error::new_from_js_message("path", "readFile", message)
                        })?;
                        std::fs::read_to_string(&resolved).map_err(|error| {
                            rquickjs::Error::new_from_js_message(
                                "path",
                                "readFile",
                                error.to_string(),
                            )
                        })
                    }
                }),
            )?,
        )?;
    }

    {
        let root = root.clone();
        globals.set(
            "writeFile",
            Function::new(
                ctx.clone(),
                Async(move |path: String, content: String| {
                    let root = root.clone();
                    async move {
                        let resolved = resolve_in_workspace(&root, &path).map_err(|message| {
                            rquickjs::Error::new_from_js_message("path", "writeFile", message)
                        })?;
                        if let Some(parent) = resolved.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        std::fs::write(&resolved, content).map_err(|error| {
                            rquickjs::Error::new_from_js_message(
                                "path",
                                "writeFile",
                                error.to_string(),
                            )
                        })?;
                        Ok::<_, rquickjs::Error>(())
                    }
                }),
            )?,
        )?;
    }

    {
        let root = root.clone();
        globals.set(
            "glob",
            Function::new(
                ctx.clone(),
                Async(move |pattern: String| {
                    let root = root.clone();
                    async move { Ok::<_, rquickjs::Error>(glob_files(&root, &pattern)) }
                }),
            )?,
        )?;
    }

    {
        let root = root.clone();
        globals.set(
            "exists",
            Function::new(
                ctx.clone(),
                Async(move |path: String| {
                    let root = root.clone();
                    async move {
                        let exists = resolve_in_workspace(&root, &path)
                            .map(|resolved| resolved.exists())
                            .unwrap_or(false);
                        Ok::<_, rquickjs::Error>(exists)
                    }
                }),
            )?,
        )?;
    }

    // exec(command, optsJson) -> JSON text
    {
        let root = root.clone();
        globals.set(
            "__native_exec",
            Function::new(
                ctx.clone(),
                Async(move |command: String, opts_json: String| {
                    let root = root.clone();
                    async move {
                        let opts: Value = serde_json::from_str(&opts_json).unwrap_or(Value::Null);
                        let timeout = opts
                            .get("timeoutMs")
                            .and_then(Value::as_u64)
                            .unwrap_or(30_000);
                        let cwd = opts
                            .get("cwd")
                            .and_then(Value::as_str)
                            .and_then(|cwd| resolve_in_workspace(&root, cwd).ok())
                            .unwrap_or_else(|| root.clone());
                        let (stdout, stderr, exit_code) = run_shell(&command, &cwd, timeout).await;
                        let value = serde_json::json!({
                            "stdout": stdout,
                            "stderr": stderr,
                            "exitCode": exit_code,
                        });
                        Ok::<String, rquickjs::Error>(json_string(&value))
                    }
                }),
            )?,
        )?;
    }

    // fetch(url, optsJson) -> JSON text
    globals.set(
        "__native_fetch",
        Function::new(
            ctx.clone(),
            Async(move |url: String, opts_json: String| async move {
                let opts: Value = serde_json::from_str(&opts_json).unwrap_or(Value::Null);
                let method = opts.get("method").and_then(Value::as_str).unwrap_or("GET");
                let body = opts.get("body").and_then(Value::as_str).map(str::to_string);
                let value = match reqwest::Client::builder()
                    .timeout(Duration::from_secs(15))
                    .build()
                {
                    Ok(client) => {
                        let mut request = client.request(
                            reqwest::Method::from_bytes(method.as_bytes())
                                .unwrap_or(reqwest::Method::GET),
                            &url,
                        );
                        if let Some(headers) = opts.get("headers").and_then(Value::as_object) {
                            for (name, header) in headers {
                                if let Some(header) = header.as_str() {
                                    request = request.header(name, header);
                                }
                            }
                        }
                        if let Some(body) = body {
                            request = request.body(body);
                        }
                        match request.send().await {
                            Ok(response) => {
                                let status = response.status().as_u16();
                                let ok = response.status().is_success();
                                let body = response.text().await.unwrap_or_default();
                                serde_json::json!({ "ok": ok, "status": status, "body": body })
                            }
                            Err(error) => serde_json::json!({
                                "ok": false,
                                "status": 0,
                                "body": error.to_string(),
                            }),
                        }
                    }
                    Err(error) => serde_json::json!({
                        "ok": false,
                        "status": 0,
                        "body": error.to_string(),
                    }),
                };
                Ok::<String, rquickjs::Error>(json_string(&value))
            }),
        )?,
    )?;

    // Prelude: wrap the native hooks, define parallel / pipeline / console / URL.
    let prelude = r#"
globalThis.agent = async (prompt, opts) => JSON.parse(await __native_agent(String(prompt), opts === undefined ? '' : JSON.stringify(opts)));
globalThis.search = async (query) => JSON.parse(await __native_search(String(query)));
globalThis.exec = async (command, opts) => JSON.parse(await __native_exec(String(command), opts === undefined ? '' : JSON.stringify(opts)));
globalThis.fetch = async (url, opts) => JSON.parse(await __native_fetch(String(url), opts === undefined ? '' : JSON.stringify(opts)));
globalThis.parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(() => t())));
globalThis.pipeline = (items, ...stages) =>
  Promise.all(items.map((item, index) =>
    stages.reduce((acc, stage) => acc.then((prev) => stage(prev, item, index)), Promise.resolve(item))));
globalThis.console = {
  log: (...a) => log(a.map(String).join(' ')),
  warn: (...a) => log(a.map(String).join(' ')),
  error: (...a) => log(a.map(String).join(' ')),
  debug: (...a) => log(a.map(String).join(' ')),
};
globalThis.URL = class URL {
  constructor(url) {
    const m = String(url).match(/^(\w+):\/\/([^/]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/);
    if (!m) throw new TypeError('Invalid URL: ' + url);
    this.protocol = m[1] + ':';
    this.hostname = m[2];
    this.pathname = m[3] ?? '/';
    this.search = m[4] ?? '';
    this.hash = m[5] ?? '';
    this.href = String(url);
  }
  toString() { return this.href; }
};
"#;
    ctx.eval::<(), _>(prelude)?;
    Ok(())
}

fn parse_opts(raw: &str) -> WorkflowAgentOpts {
    if raw.trim().is_empty() {
        return WorkflowAgentOpts::default();
    }
    serde_json::from_str(raw).unwrap_or_default()
}

fn resolve_in_workspace(root: &Path, path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path);
    if candidate.is_absolute() || path.split(['/', '\\']).any(|part| part == "..") {
        return Err(format!("Path escapes workspace root: {path}"));
    }
    let root_canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let resolved = root_canonical.join(path);
    if !resolved.starts_with(&root_canonical) {
        return Err(format!("Path escapes workspace root: {path}"));
    }
    Ok(resolved)
}

const GLOB_IGNORED_DIRS: &[&str] = &["node_modules", ".git"];
const MAX_GLOB_DEPTH: usize = 8;
const MAX_GLOB_RESULTS: usize = 1000;

fn glob_files(root: &Path, pattern: &str) -> Vec<String> {
    let Ok(glob) = globset::Glob::new(pattern) else {
        return Vec::new();
    };
    let matcher = glob.compile_matcher();
    let mut results = Vec::new();
    walk(root, root, &matcher, 0, &mut results);
    results
}

fn walk(
    root: &Path,
    dir: &Path,
    matcher: &globset::GlobMatcher,
    depth: usize,
    results: &mut Vec<String>,
) {
    if depth > MAX_GLOB_DEPTH || results.len() >= MAX_GLOB_RESULTS {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if results.len() >= MAX_GLOB_RESULTS {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if GLOB_IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk(root, &path, matcher, depth + 1, results);
        } else if let Ok(relative) = path.strip_prefix(root) {
            let relative = relative.to_string_lossy().replace('\\', "/");
            if matcher.is_match(&relative) {
                results.push(relative);
            }
        }
    }
}

async fn run_shell(command: &str, cwd: &Path, timeout_ms: u64) -> (String, String, i32) {
    #[cfg(windows)]
    let mut process = {
        let mut process = tokio::process::Command::new("cmd");
        process.arg("/C").arg(command);
        process
    };
    #[cfg(not(windows))]
    let mut process = {
        let mut process = tokio::process::Command::new("sh");
        process.arg("-c").arg(command);
        process
    };
    process.current_dir(cwd);
    process.kill_on_drop(true);

    match tokio::time::timeout(Duration::from_millis(timeout_ms), process.output()).await {
        Ok(Ok(output)) => (
            String::from_utf8_lossy(&output.stdout).to_string(),
            String::from_utf8_lossy(&output.stderr).to_string(),
            output.status.code().unwrap_or(1),
        ),
        Ok(Err(error)) => (String::new(), error.to_string(), 1),
        Err(_) => (String::new(), "command timed out".to_string(), 1),
    }
}

// ── JSON -> JS conversion (sync only; async hooks return JSON text) ────────

#[cfg(feature = "workflow-js")]
fn json_to_js<'js>(ctx: &Ctx<'js>, value: &Value) -> rquickjs::Result<JsValue<'js>> {
    Ok(match value {
        Value::Null => JsValue::new_null(ctx.clone()),
        Value::Bool(boolean) => JsValue::new_bool(ctx.clone(), *boolean),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                JsValue::new_int(ctx.clone(), integer as i32)
            } else if let Some(float) = number.as_f64() {
                JsValue::new_float(ctx.clone(), float)
            } else {
                JsValue::new_null(ctx.clone())
            }
        }
        Value::String(text) => rquickjs::String::from_str(ctx.clone(), text)?.into_value(),
        Value::Array(items) => {
            let array = Array::new(ctx.clone())?;
            for (index, item) in items.iter().enumerate() {
                array.set(index, json_to_js(ctx, item)?)?;
            }
            array.into_value()
        }
        Value::Object(map) => {
            let object = Object::new(ctx.clone())?;
            for (key, item) in map {
                object.set(key.as_str(), json_to_js(ctx, item)?)?;
            }
            object.into_value()
        }
    })
}

#[cfg(feature = "workflow-js")]
fn js_to_json(value: &JsValue<'_>) -> Value {
    if value.is_null() || value.is_undefined() {
        return Value::Null;
    }
    if let Some(boolean) = value.as_bool() {
        return Value::Bool(boolean);
    }
    if let Some(integer) = value.as_int() {
        return Value::from(integer);
    }
    if let Some(float) = value.as_float() {
        return serde_json::Number::from_f64(float)
            .map(Value::Number)
            .unwrap_or(Value::Null);
    }
    if let Some(text) = value.as_string() {
        return Value::String(text.to_string().unwrap_or_default());
    }
    if let Some(array) = value.as_array() {
        let items: Vec<Value> = (0..array.len())
            .filter_map(|index| {
                array
                    .get::<JsValue>(index)
                    .ok()
                    .map(|item| js_to_json(&item))
            })
            .collect();
        return Value::Array(items);
    }
    if let Some(object) = value.as_object() {
        let mut map = serde_json::Map::new();
        for (key, item) in object.props::<String, JsValue>().flatten() {
            map.insert(key, js_to_json(&item));
        }
        return Value::Object(map);
    }
    Value::Null
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "workflow-js")]
    #[tokio::test]
    async fn json_round_trips_through_js() {
        let runtime = AsyncRuntime::new().unwrap();
        let ctx = AsyncContext::full(&runtime).await.unwrap();
        let source = serde_json::json!({
            "n": 3,
            "s": "text",
            "b": true,
            "a": [1, 2, null],
            "o": { "k": "v" },
        });
        let value = rquickjs::async_with!(ctx => |ctx| {
            let js = json_to_js(&ctx, &source)?;
            Ok::<_, rquickjs::Error>(js_to_json(&js))
        })
        .await
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "n": 3,
                "s": "text",
                "b": true,
                "a": [1, 2, null],
                "o": { "k": "v" },
            })
        );
    }

    #[test]
    fn resolves_paths_inside_the_workspace() {
        let root = std::env::temp_dir();
        assert!(resolve_in_workspace(&root, "a/b.txt").is_ok());
        assert!(resolve_in_workspace(&root, "../escape.txt").is_err());
        assert!(resolve_in_workspace(&root, "/abs.txt").is_err());
    }
}
