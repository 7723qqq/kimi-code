//! Turn-loop throughput benchmarks — the P5 relative baseline (no real LLM).
//!
//! Measures the engine's own per-step / per-tool overhead with instant fakes:
//!   1. Step throughput through `run_turn` with 1 vs 8 concurrent tool calls
//!      per step (fake LLM, instant host stub).
//!   2. Native in-process tool execution (real file Read, sandboxed) vs the
//!      host-callback dispatch floor (instant stub) for the same calls.
//!
//! Run with:
//!   cargo test --release --test turn_bench -- --ignored --nocapture
//!
//! These numbers complement (not replace) the real-key native-LLM vs
//! host-proxy benchmark documented in ROADMAP P5: provider latency dominates
//! real turns, so treat these as the engine's overhead floor.

use std::hint::black_box;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use kimi_agent::callbacks::{HostCallbacks, NativeToolCallbacks};
use kimi_agent::rpc::types::{
    BoxFuture, LlmChatRequest, LlmChatResponse, TokenUsage, ToolExecuteRequest, ToolExecuteResponse,
};
use kimi_agent::tools::NativeToolset;
use kimi_agent::turn_loop::run_turn::run_turn;
use kimi_agent::turn_loop::types::*;

const WARMUP_STEPS: u32 = 20;
const MEASURE_STEPS: u32 = 200;
const FILE_SIZE_BYTES: usize = 4096;

/// Fake LLM: every step returns `calls_per_step` Read tool calls with
/// distinct paths, so the loop never completes on its own and runs exactly
/// `max_steps` steps.
struct BenchLlm {
    paths: Vec<String>,
}

impl LLM for BenchLlm {
    fn system_prompt(&self) -> &str {
        "bench"
    }
    fn model_name(&self) -> &str {
        "bench-model"
    }
    fn is_retryable_error(&self, _: &str) -> bool {
        false
    }

    fn chat(
        &self,
        _: LLMChatParams,
    ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
        let calls: Vec<ToolCall> = self
            .paths
            .iter()
            .enumerate()
            .map(|(i, path)| ToolCall {
                id: format!("call-{i}"),
                name: "read".into(),
                arguments: serde_json::json!({ "path": path }),
            })
            .collect();
        Box::pin(async move {
            Ok(LLMChatResponse {
                content: String::new(),
                tool_calls: calls,
                finish_reason: Some("tool_calls".into()),
                usage: TokenUsage {
                    input_tokens: 100,
                    output_tokens: 10,
                    total_tokens: 110,
                    ..Default::default()
                },
            })
        })
    }
}

/// Instant host stub: tools resolve immediately with canned output; this is
/// the host-dispatch floor (no real JS hop, no real tool work).
struct InstantHost {
    calls: AtomicU32,
}

impl HostCallbacks for InstantHost {
    fn llm_chat(&self, _: LlmChatRequest) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
        Box::pin(async { Err("llm_chat unused in bench".into()) })
    }

    fn execute_tool(
        &self,
        _: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Box::pin(async move {
            Ok(ToolExecuteResponse {
                content: "x".repeat(64),
                is_error: false,
                note: None,
            })
        })
    }

    fn check_permission(
        &self,
        _: kimi_agent::rpc::types::PermissionCheckRequest,
    ) -> kimi_agent::rpc::types::BoxFuture<
        'static,
        Result<kimi_agent::rpc::types::PermissionDecision, String>,
    > {
        Box::pin(async {
            Ok(kimi_agent::rpc::types::PermissionDecision {
                decision: "allow".into(),
                reason: None,
            })
        })
    }

    fn emit_event(&self, _: serde_json::Value) {}
}

/// Write the sandbox files the bench Read calls target.
fn make_sandbox(dir: &std::path::Path, files: usize) -> Vec<String> {
    let content = "b".repeat(FILE_SIZE_BYTES);
    (0..files)
        .map(|i| {
            let path = dir.join(format!("f{i}.txt"));
            std::fs::write(&path, &content).expect("write sandbox file");
            path.to_string_lossy().into_owned()
        })
        .collect()
}

async fn run_turn_sync(
    llm: &BenchLlm,
    callbacks: &Arc<dyn HostCallbacks>,
    steps: u32,
) -> TurnResult {
    let input = RunTurnInput {
        turn_id: "bench-turn".into(),
        llm,
        messages: vec![LLMMessage {
            role: "user".into(),
            content: "bench".into(),
            ..Default::default()
        }],
        tools: &[],
        tool_defs: vec![],
        max_steps: steps,
        goal: None,
        cancellation: None,
    };
    run_turn(black_box(input), callbacks)
        .await
        .expect("bench turn must succeed")
}

fn report(name: &str, elapsed: Duration, steps: u32, calls: u32) {
    let total_ms = elapsed.as_secs_f64() * 1000.0;
    println!(
        "{name:<46} {total_ms:>9.2} ms total | {:>8.1} steps/s | {:>9.1} tool-calls/s | {:>7.2} µs/step",
        steps as f64 / elapsed.as_secs_f64(),
        calls as f64 / elapsed.as_secs_f64(),
        total_ms * 1000.0 / steps as f64,
    );
}

/// End-to-end step throughput: scheduling + conflict batching + message
/// bookkeeping, with the host stub as the only tool backend.
async fn bench_step_throughput(paths: &[String], label: &str) {
    let llm = BenchLlm {
        paths: paths.to_vec(),
    };
    let host: Arc<dyn HostCallbacks> = Arc::new(InstantHost {
        calls: AtomicU32::new(0),
    });

    run_turn_sync(&llm, &host, WARMUP_STEPS).await;

    let started = Instant::now();
    let result = run_turn_sync(&llm, &host, MEASURE_STEPS).await;
    let elapsed = started.elapsed();

    let calls = MEASURE_STEPS * paths.len() as u32;
    assert_eq!(result.steps, MEASURE_STEPS);
    report(
        &format!("{label} ({} tools/step)", paths.len()),
        elapsed,
        result.steps,
        calls,
    );
}

/// Native in-process Read (real file I/O through the sandbox) vs the
/// host-stub dispatch floor for the same call volume.
async fn bench_native_vs_host(dir: &std::path::Path) {
    let paths = make_sandbox(dir, 8);
    let llm = BenchLlm {
        paths: paths.clone(),
    };

    // Host dispatch floor: same turns as the throughput bench, already run
    // there; re-measure for a back-to-back comparison under this sandbox.
    let host: Arc<dyn HostCallbacks> = Arc::new(InstantHost {
        calls: AtomicU32::new(0),
    });
    run_turn_sync(&llm, &host, WARMUP_STEPS).await;
    let started = Instant::now();
    run_turn_sync(&llm, &host, MEASURE_STEPS).await;
    let host_elapsed = started.elapsed();

    // Native path: Read executes inside the Rust process on real files.
    let toolset =
        Arc::new(NativeToolset::new(dir.to_str().expect("utf8 path"), None).expect("sandbox"));
    let native: Arc<dyn HostCallbacks> = Arc::new(NativeToolCallbacks {
        inner: host.clone(),
        toolset,
        native_count: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        truncator: None,
        permission_engine: None,
    });
    run_turn_sync(&llm, &native, WARMUP_STEPS).await;
    let started = Instant::now();
    run_turn_sync(&llm, &native, MEASURE_STEPS).await;
    let native_elapsed = started.elapsed();

    let calls = MEASURE_STEPS * paths.len() as u32;
    report(
        "host dispatch floor (stub)",
        host_elapsed,
        MEASURE_STEPS,
        calls,
    );
    report(
        "native in-process Read (real files)",
        native_elapsed,
        MEASURE_STEPS,
        calls,
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "benchmark: run with --ignored --nocapture"]
async fn bench_turn_loop() {
    let dir = tempfile::tempdir().expect("tempdir");
    let one = vec![dir.path().join("f0.txt").to_string_lossy().into_owned()];
    let eight = (0..8)
        .map(|i| {
            dir.path()
                .join(format!("f{i}.txt"))
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    make_sandbox(dir.path(), 8);

    bench_step_throughput(&one, "turn-loop steps").await;
    bench_step_throughput(&eight, "turn-loop steps").await;
    bench_native_vs_host(dir.path()).await;
}
