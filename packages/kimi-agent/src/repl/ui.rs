//! Terminal ANSI styling and rich formatted rendering (P31).

use serde_json::Value;
use std::io::{self, Write};

use crate::rpc::types::TokenUsage;

pub struct Colors;

impl Colors {
    pub const RESET: &'static str = "\x1b[0m";
    pub const BOLD: &'static str = "\x1b[1m";
    pub const DIM: &'static str = "\x1b[2m";
    pub const CYAN: &'static str = "\x1b[36m";
    pub const BRIGHT_CYAN: &'static str = "\x1b[96m";
    pub const GREEN: &'static str = "\x1b[32m";
    pub const BRIGHT_GREEN: &'static str = "\x1b[92m";
    pub const YELLOW: &'static str = "\x1b[33m";
    pub const BRIGHT_YELLOW: &'static str = "\x1b[93m";
    pub const BLUE: &'static str = "\x1b[34m";
    pub const MAGENTA: &'static str = "\x1b[35m";
    pub const RED: &'static str = "\x1b[31m";
    pub const GRAY: &'static str = "\x1b[90m";
}

pub fn render_banner(workspace: &std::path::Path, model: &str, session_id: &str) {
    let logo = r#"
   __ __ _           _    ___                   _     
  / //_/(_)__ _     (_)  / _ | ___ _ ___  ___  / /_   
 / ,<  / //  ' \ _ / /  / __ |/ _ `// -_)/ _ \/ __/   
/_/|_|/_//_/_/_/(_)_/  /_/ |_|\_, / \__//_//_/\__/    
                             /___/                    
"#;
    println!("{}{logo}", Colors::BRIGHT_CYAN);
    println!(
        "{}  ┌────────────────────────────────────────────────────────────┐{}",
        Colors::CYAN,
        Colors::RESET
    );
    println!(
        "{}  │{} {}Kimi Code Native Engine{} (Pure Rust Standalone Binary)    {}│{}",
        Colors::CYAN,
        Colors::RESET,
        Colors::BOLD,
        Colors::RESET,
        Colors::CYAN,
        Colors::RESET
    );
    println!(
        "{}  │{}  • Workspace:  {}{:<41}{}│{}",
        Colors::CYAN,
        Colors::RESET,
        Colors::YELLOW,
        truncate_str(&workspace.display().to_string(), 41),
        Colors::CYAN,
        Colors::RESET
    );
    println!(
        "{}  │{}  • Session:    {}{:<41}{}│{}",
        Colors::CYAN,
        Colors::RESET,
        Colors::MAGENTA,
        truncate_str(session_id, 41),
        Colors::CYAN,
        Colors::RESET
    );
    println!(
        "{}  │{}  • Model:      {}{:<41}{}│{}",
        Colors::CYAN,
        Colors::RESET,
        Colors::BRIGHT_GREEN,
        truncate_str(model, 41),
        Colors::CYAN,
        Colors::RESET
    );
    println!(
        "{}  │{}  Type {}/help{} for slash commands, {}/exit{} to quit.          {}│{}",
        Colors::CYAN,
        Colors::RESET,
        Colors::BRIGHT_YELLOW,
        Colors::RESET,
        Colors::BRIGHT_YELLOW,
        Colors::RESET,
        Colors::CYAN,
        Colors::RESET
    );
    println!(
        "{}  └────────────────────────────────────────────────────────────┘{}\n",
        Colors::CYAN,
        Colors::RESET
    );
}

pub fn render_prompt() {
    print!(
        "{}{}kimi > {}{}",
        Colors::BOLD,
        Colors::BRIGHT_CYAN,
        Colors::RESET,
        Colors::CYAN
    );
    let _ = io::stdout().flush();
}

pub fn render_tool_call(tool_name: &str, args: &Value, is_error: bool, note: Option<&str>) {
    let status_icon = if is_error {
        format!("{}✗ error{}", Colors::RED, Colors::RESET)
    } else {
        format!("{}✓ ok{}", Colors::GREEN, Colors::RESET)
    };

    let note_str = match note {
        Some(n) => format!(" {}{}[{}]{}", Colors::DIM, Colors::GRAY, n, Colors::RESET),
        None => String::new(),
    };

    let preview = format_args_preview(args);

    println!(
        "  {}▶ {}{}{}({}{}{}) {}{}{}",
        Colors::BRIGHT_YELLOW,
        Colors::BOLD,
        tool_name,
        Colors::RESET,
        Colors::GRAY,
        preview,
        Colors::RESET,
        status_icon,
        note_str,
        Colors::RESET
    );
}

pub fn render_status_panel(
    workspace: &std::path::Path,
    model: &str,
    session_id: &str,
    yolo: bool,
    turns_count: usize,
    usage: &TokenUsage,
    goal: Option<&crate::turn_loop::types::GoalContext>,
) {
    println!(
        "\n{}── Session Status ──────────────────────────────────────────{}",
        Colors::CYAN,
        Colors::RESET
    );
    println!(
        "  Workspace:  {}{}{}",
        Colors::BOLD,
        workspace.display(),
        Colors::RESET
    );
    println!(
        "  Session ID: {}{}{}",
        Colors::MAGENTA,
        session_id,
        Colors::RESET
    );
    println!(
        "  Model:      {}{}{}",
        Colors::BRIGHT_GREEN,
        model,
        Colors::RESET
    );
    println!(
        "  YOLO Mode:  {}",
        if yolo {
            format!(
                "{}{}ENABLED (Auto-approve writes){}",
                Colors::BOLD,
                Colors::BRIGHT_YELLOW,
                Colors::RESET
            )
        } else {
            format!(
                "{}DISABLED (Manual confirmation){}",
                Colors::GRAY,
                Colors::RESET
            )
        }
    );
    println!(
        "  Turns:      {}{}{}",
        Colors::BOLD,
        turns_count,
        Colors::RESET
    );
    println!(
        "  Tokens:     Prompt: {} | Completion: {} | Cache: {} | Total: {}{}{}{}",
        usage.input_tokens,
        usage.output_tokens,
        usage.input_cache_read,
        Colors::BOLD,
        Colors::BRIGHT_CYAN,
        usage.total_tokens,
        Colors::RESET
    );
    if let Some(goal) = goal {
        let status_color = match goal.status {
            crate::turn_loop::types::GoalStatus::Active => Colors::BRIGHT_GREEN,
            crate::turn_loop::types::GoalStatus::Paused => Colors::BRIGHT_YELLOW,
            crate::turn_loop::types::GoalStatus::Blocked => Colors::RED,
            _ => Colors::GRAY,
        };
        let status = match goal.status {
            crate::turn_loop::types::GoalStatus::Active => "active",
            crate::turn_loop::types::GoalStatus::Paused => "paused",
            crate::turn_loop::types::GoalStatus::Blocked => "blocked",
            crate::turn_loop::types::GoalStatus::Complete => "complete",
            crate::turn_loop::types::GoalStatus::BudgetLimited => "budget_limited",
            crate::turn_loop::types::GoalStatus::UsageLimited => "usage_limited",
        };
        println!(
            "  Goal:       {}{}{} — {}",
            status_color,
            status,
            Colors::RESET,
            truncate_str(&goal.objective, 60)
        );
        println!(
            "  Goal Usage: {} turns | {} tokens{}",
            goal.turns_used,
            goal.tokens_used,
            match goal.turn_budget {
                Some(budget) => format!(" / {budget} turn budget"),
                None => String::new(),
            }
        );
    }
    println!(
        "{}────────────────────────────────────────────────────────────{}\n",
        Colors::CYAN,
        Colors::RESET
    );
}

fn truncate_str(s: &str, max_len: usize) -> String {
    if s.chars().count() <= max_len {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_len.saturating_sub(3)).collect();
        format!("{truncated}...")
    }
}

fn format_args_preview(args: &Value) -> String {
    if let Some(obj) = args.as_object() {
        let mut keys: Vec<String> = obj
            .iter()
            .take(3)
            .map(|(k, v)| {
                let val_str = match v {
                    Value::String(s) => truncate_str(s, 20),
                    _ => truncate_str(&v.to_string(), 20),
                };
                format!("{k}={val_str}")
            })
            .collect();
        if obj.len() > 3 {
            keys.push("...".into());
        }
        keys.join(", ")
    } else {
        truncate_str(&args.to_string(), 40)
    }
}
