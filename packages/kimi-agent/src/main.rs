/// kimi-agent — Rust agent engine with stdio JSON-RPC bridge.
///
/// Usage:
///   kimi-agent [--version]
///
/// Normal operation reads JSON-RPC 2.0 requests from stdin and writes
/// responses/notifications to stdout.

use clap::Parser;

mod hooks;
mod llm;
mod rpc;
mod turn_loop;

use rpc::server::RpcServer;
use rpc::types::{self, HealthStatus, RunTurnResult};

#[derive(Parser)]
#[command(name = "kimi-agent", version = "0.1.0", about = "Kimi Agent engine (Rust)")]
struct Cli {
    /// Run a health check and exit
    #[arg(long)]
    health: bool,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    if cli.health {
        // Health check: print status and exit
        let status = HealthStatus {
            status: "ok".into(),
            version: "0.1.0".into(),
        };
        println!("{}", serde_json::to_string(&status)?);
        return Ok(());
    }

    // Build the RPC server and register handlers
    let server = RpcServer::new();

    // Register run_turn handler
    server.register(types::methods::RUN_TURN, |params| {
        let _input: types::RunTurnParams = serde_json::from_value(params)
            .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;

        // TODO: actual run_turn implementation
        // For now, return a mock result
        let result = RunTurnResult {
            stop_reason: "EndTurn".into(),
            steps: 0,
            usage: types::TokenUsage::default(),
        };

        serde_json::to_value(&result)
            .map_err(|e| types::JsonRpcError::internal_error(format!("Serialization error: {e}")))
    });

    // Register health handler
    server.register(types::methods::HEALTH, |_| {
        let status = HealthStatus {
            status: "ok".into(),
            version: "0.1.0".into(),
        };
        serde_json::to_value(&status)
            .map_err(|e| types::JsonRpcError::internal_error(format!("Serialization error: {e}")))
    });

    // Register shutdown handler
    server.register(types::methods::SHUTDOWN, |_| {
        std::process::exit(0);
    });

    // Run the server
    eprintln!("kimi-agent ready, listening on stdin/stdout");
    server.run()?;

    Ok(())
}