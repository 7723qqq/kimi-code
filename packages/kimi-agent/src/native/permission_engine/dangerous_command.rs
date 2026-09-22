//! 原生危险命令词法分析器（对齐 v2 `dangerous-command-ask.ts`）。
//!
//! 负责分析 Bash 命令行，检测关机、重启、格式化、dd 物理设备覆盖、
//! 以及透过 sudo / doas / nohup / bash -c 等包装的高危破坏性指令。
//!
//! `rm -rf` 自 upstream #3714 起有一个豁免：当**全部**操作数都是 `/tmp`
//! 或 `/temp` 下的字面量路径（逐段比较前缀、不含 `..`、不含参数展开/通配
//! 元字符）时不再判危险。Rust 侧没有 tree-sitter 的字面量元数据，因此把
//! 上游 `literalText` 的 `UNSAFE_OPERAND` 判据折叠进操作数自身的检查里；
//! 重定向目标会被朴素分词器当成操作数，故 `rm -rf /tmp/x > log` 在 Rust 侧
//! 仍判危险（偏保守，fail-closed）。

pub const SIMPLE_DANGEROUS_COMMANDS: &[&str] = &[
    "shutdown",
    "halt",
    "poweroff",
    "reboot",
    "bcdedit",
    "diskpart",
    "format",
    "restart-computer",
    "stop-computer",
    "mkfs",
    "wipefs",
];

pub const PRIVILEGE_WRAPPERS: &[&str] = &["sudo", "doas"];

pub const PRIVILEGE_VALUE_OPTIONS: &[&str] = &[
    "-u",
    "--user",
    "-g",
    "--group",
    "-h",
    "--host",
    "-p",
    "--prompt",
    "-C",
    "--close-from",
    "-T",
    "--command-timeout",
    "-U",
    "--other-user",
    "-r",
    "--role",
    "-t",
    "--type",
];

pub const LAUNCH_WRAPPERS: &[&str] = &["env", "command", "exec", "nohup", "builtin", "nice"];

pub const WRAPPER_VALUE_OPTIONS: &[&str] = &[
    "-u",
    "--unset",
    "-C",
    "--chdir",
    "-S",
    "--split-string",
    "-a",
    "-n",
    "--adjustment",
];

pub const NESTED_SHELLS: &[&str] = &["sh", "bash", "dash", "zsh", "ksh", "ash"];

pub const SYSTEMCTL_DANGEROUS_SUBCOMMANDS: &[&str] = &["poweroff", "reboot", "halt", "kexec"];

/// Roots whose recursive force deletion is exempt from the dangerous-command
/// ask (v2 `RM_SAFE_TEMP_ROOTS`, upstream #3714).
pub const RM_SAFE_TEMP_ROOTS: &[&str] = &["/tmp", "/temp"];

/// Characters that make an operand non-literal (v2 `UNSAFE_OPERAND`): parameter
/// expansion, command substitution, globbing, character classes and `~`.
/// Upstream decides this with tree-sitter's `literalText`; the native lexer has
/// no syntax metadata, so the same character set is applied to the operand.
const UNSAFE_OPERAND_CHARS: &[char] = &['$', '`', '*', '?', '[', ']', '~'];

#[derive(Debug, PartialEq, Eq)]
pub enum DangerousVerdict {
    Dangerous(String),
    /// The command could not be read statically — an unbalanced quote, or a
    /// command name that is not a literal so what will run is only known at
    /// execution time (v2's tree-sitter parse failure; upstream #3869's
    /// `unanalyzable`).
    Unanalyzable(String),
    Safe,
}

/// 分析复合 Bash 脚本或单条命令是否包含破坏性指令
///
/// A `Dangerous` verdict anywhere wins; otherwise an unanalyzable shape
/// anywhere makes the whole command unanalyzable (upstream #3869).
pub fn analyze_bash_command(raw_command: &str) -> DangerousVerdict {
    let (sub_commands, balanced) = split_pipeline_commands(raw_command);
    let mut unanalyzable: Option<String> = None;
    for sub_cmd in &sub_commands {
        match check_single_command(sub_cmd) {
            DangerousVerdict::Dangerous(cmd) => return DangerousVerdict::Dangerous(cmd),
            DangerousVerdict::Unanalyzable(cmd) => unanalyzable = Some(cmd),
            DangerousVerdict::Safe => {}
        }
    }
    if !balanced {
        return DangerousVerdict::Unanalyzable(raw_command.to_string());
    }
    unanalyzable.map_or(DangerousVerdict::Safe, DangerousVerdict::Unanalyzable)
}

fn split_pipeline_commands(cmd: &str) -> (Vec<String>, bool) {
    let mut results = Vec::new();
    let mut current = String::new();
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut chars = cmd.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '\'' if !in_double_quote => in_single_quote = !in_single_quote,
            '"' if !in_single_quote => in_double_quote = !in_double_quote,
            ';' | '\n' if !in_single_quote && !in_double_quote => {
                if !current.trim().is_empty() {
                    results.push(current.trim().to_string());
                    current.clear();
                }
                continue;
            }
            '&' if !in_single_quote && !in_double_quote => {
                if chars.peek() == Some(&'&') {
                    chars.next();
                }
                if !current.trim().is_empty() {
                    results.push(current.trim().to_string());
                    current.clear();
                }
                continue;
            }
            '|' if !in_single_quote && !in_double_quote => {
                if chars.peek() == Some(&'|') {
                    chars.next();
                }
                if !current.trim().is_empty() {
                    results.push(current.trim().to_string());
                    current.clear();
                }
                continue;
            }
            _ => {}
        }
        current.push(c);
    }
    if !current.trim().is_empty() {
        results.push(current.trim().to_string());
    }
    // A quote still open at end-of-input is a lexer-level failure: the tail
    // after it cannot be split or tokenized trustworthily (v2's tree-sitter
    // parse failure; upstream #3869's `unanalyzable`).
    (results, !in_single_quote && !in_double_quote)
}

/// 归一化命令名称：剥离路径前缀与 Windows .exe 后缀
pub fn normalize_command_name(raw: &str) -> String {
    let mut name = raw;
    if let Some(pos) = name.rfind(['/', '\\']) {
        name = &name[pos + 1..];
    }
    let mut lower = name.to_ascii_lowercase();
    if lower.ends_with(".exe") {
        lower.truncate(lower.len() - 4);
    }
    lower
}

/// Whether `arg` is a short option cluster (`-rf`, `-Rfv`) as opposed to a long
/// option or an operand (v2 regex `^-[a-zA-Z]+$`).
fn is_short_option_cluster(arg: &str) -> bool {
    let Some(flags) = arg.strip_prefix('-') else {
        return false;
    };
    !flags.is_empty() && flags.chars().all(|c| c.is_ascii_alphabetic())
}

/// Whether a single `rm` operand is a literal path under one of
/// [`RM_SAFE_TEMP_ROOTS`] (v2 `isSafeTempRmOperand` plus the literal-ness rule
/// that upstream tracks separately via `dropped`).
fn is_safe_temp_rm_operand(operand: &str) -> bool {
    if operand.is_empty() || operand.contains(UNSAFE_OPERAND_CHARS) {
        return false;
    }
    if operand.split('/').any(|segment| segment == "..") {
        return false;
    }
    RM_SAFE_TEMP_ROOTS.iter().any(|root| {
        operand
            .strip_prefix(root)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    })
}

fn check_single_command(cmd: &str) -> DangerousVerdict {
    let tokens = tokenize_command(cmd);
    if tokens.is_empty() {
        return DangerousVerdict::Safe;
    }

    let mut current_tokens = &tokens[..];
    while !current_tokens.is_empty() {
        let first = normalize_command_name(&current_tokens[0]);

        // 1. 基础破坏性命令拦截 (含 mkfs.* 变体)
        if SIMPLE_DANGEROUS_COMMANDS.contains(&first.as_str()) || first.starts_with("mkfs.") {
            return DangerousVerdict::Dangerous(first);
        }

        // 2. init / telinit 关机重启运行级别拦截 (init 0 / init 6)
        if first == "init" || first == "telinit" {
            for arg in &current_tokens[1..] {
                if arg == "0" || arg == "6" {
                    return DangerousVerdict::Dangerous(format!("{} {}", first, arg));
                }
            }
        }

        // 3. systemctl 致命子命令拦截
        if first == "systemctl" {
            for sub in &current_tokens[1..] {
                let norm_sub = normalize_command_name(sub);
                if !sub.starts_with('-')
                    && SYSTEMCTL_DANGEROUS_SUBCOMMANDS.contains(&norm_sub.as_str())
                {
                    return DangerousVerdict::Dangerous(format!("systemctl {}", sub));
                }
            }
        }

        // 4. dd 物理存储设备覆写拦截
        if first == "dd" {
            for arg in &current_tokens[1..] {
                if let Some(target) = arg.strip_prefix("of=")
                    && (target.starts_with("/dev/sd")
                        || target.starts_with("/dev/nvme")
                        || target.starts_with("/dev/hd")
                        || target == "/dev/sda")
                {
                    return DangerousVerdict::Dangerous(format!("dd of={}", target));
                }
            }
        }

        // 5. rm -rf 危险删除拦截 (对齐 TS dangerous-command-ask rm 递归强制规范)
        //    仅当全部操作数都是 /tmp、/temp 下的字面量路径时放行 (upstream #3714)。
        if first == "rm" {
            let mut recursive = false;
            let mut force = false;
            let mut operands: Vec<&str> = Vec::new();
            let mut options_ended = false;
            for arg in &current_tokens[1..] {
                if !options_ended && arg == "--" {
                    options_ended = true;
                    continue;
                }
                if options_ended {
                    operands.push(arg);
                    continue;
                }
                if arg == "--recursive" {
                    recursive = true;
                } else if arg == "--force" {
                    force = true;
                } else if is_short_option_cluster(arg) {
                    if arg.contains('r') || arg.contains('R') {
                        recursive = true;
                    }
                    if arg.contains('f') {
                        force = true;
                    }
                } else {
                    operands.push(arg);
                }
            }
            if recursive && force {
                if !operands.is_empty()
                    && operands
                        .iter()
                        .all(|operand| is_safe_temp_rm_operand(operand))
                {
                    return DangerousVerdict::Safe;
                }
                return DangerousVerdict::Dangerous("rm -rf".into());
            }
        }

        // 6. busybox 提取子命令递归
        if first == "busybox" && current_tokens.len() > 1 {
            let applet = &current_tokens[1];
            if !applet.starts_with('-') {
                current_tokens = &current_tokens[1..];
                continue;
            }
        }

        // 7. eval 递归分析
        if first == "eval" && current_tokens.len() > 1 {
            let joined = current_tokens[1..].join(" ");
            return analyze_bash_command(&joined);
        }

        // 8. 递归剥离包装器 (sudo, doas, env, nohup, nice)
        if PRIVILEGE_WRAPPERS.contains(&first.as_str()) || LAUNCH_WRAPPERS.contains(&first.as_str())
        {
            let mut next_cmd_idx = 1;
            while next_cmd_idx < current_tokens.len() {
                let opt = &current_tokens[next_cmd_idx];
                if opt == "--" {
                    next_cmd_idx += 1;
                    break;
                }
                if opt.starts_with('-') {
                    if PRIVILEGE_VALUE_OPTIONS.contains(&opt.as_str())
                        || WRAPPER_VALUE_OPTIONS.contains(&opt.as_str())
                    {
                        next_cmd_idx += 2;
                    } else {
                        next_cmd_idx += 1;
                    }
                } else {
                    break;
                }
            }
            if next_cmd_idx < current_tokens.len() {
                current_tokens = &current_tokens[next_cmd_idx..];
                continue;
            }
        }

        // 9. 递归分析嵌套 shell (bash -c "...")
        if NESTED_SHELLS.contains(&first.as_str())
            && let Some(pos) = current_tokens.iter().position(|t| t == "-c")
            && pos + 1 < current_tokens.len()
        {
            return analyze_bash_command(&current_tokens[pos + 1]);
        }

        break;
    }

    // 10. 命令名不是字面量时无法静态解析（v2 的 tree-sitter 在同形态上解析失败，
    //     upstream #3869 的 unanalyzable）：`$CMD --force` 之类要到执行时才知道
    //     跑什么。危险判定全部落空之后才检查——`$SUDO reboot` 已被上面的包装器
    //     剥离路径判危，且检查的是剥离后的当前命令名。
    let name = &current_tokens[0];
    if name.starts_with('$') || name.contains('`') {
        return DangerousVerdict::Unanalyzable(cmd.to_string());
    }

    DangerousVerdict::Safe
}

fn tokenize_command(cmd: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_single_quote = false;
    let mut in_double_quote = false;

    for c in cmd.chars() {
        match c {
            '\'' if !in_double_quote => in_single_quote = !in_single_quote,
            '"' if !in_single_quote => in_double_quote = !in_double_quote,
            ' ' | '\t' if !in_single_quote && !in_double_quote => {
                if !current.is_empty() {
                    tokens.push(current.clone());
                    current.clear();
                }
            }
            _ => current.push(c),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_direct_dangerous_commands() {
        assert_eq!(
            analyze_bash_command("shutdown -h now"),
            DangerousVerdict::Dangerous("shutdown".into())
        );
        assert_eq!(
            analyze_bash_command("reboot"),
            DangerousVerdict::Dangerous("reboot".into())
        );
        assert_eq!(
            analyze_bash_command("format C: /q"),
            DangerousVerdict::Dangerous("format".into())
        );
    }

    #[test]
    fn test_sudo_wrapper_dangerous_commands() {
        assert_eq!(
            analyze_bash_command("sudo reboot"),
            DangerousVerdict::Dangerous("reboot".into())
        );
        assert_eq!(
            analyze_bash_command("sudo -u root poweroff"),
            DangerousVerdict::Dangerous("poweroff".into())
        );
        assert_eq!(
            analyze_bash_command("nohup sudo systemctl reboot &"),
            DangerousVerdict::Dangerous("systemctl reboot".into())
        );
    }

    #[test]
    fn test_nested_shell_dangerous_commands() {
        assert_eq!(
            analyze_bash_command("bash -c 'sudo dd if=/dev/zero of=/dev/sda bs=1M'"),
            DangerousVerdict::Dangerous("dd of=/dev/sda".into())
        );
    }

    #[test]
    fn test_rm_rf_temp_paths_are_exempt() {
        for allowed in [
            "rm -rf /tmp/build",
            "rm -rf /temp/cache",
            "rm -rf /tmp",
            "rm -rf -- /tmp/build",
            "rm -r -f /tmp/a /tmp/b",
            "sudo rm -rf /tmp/build",
            "bash -c 'rm -rf /tmp/build'",
        ] {
            assert_eq!(
                analyze_bash_command(allowed),
                DangerousVerdict::Safe,
                "expected safe: {allowed}"
            );
        }
    }

    #[test]
    fn test_rm_rf_outside_temp_paths_stay_dangerous() {
        for dangerous in [
            "rm -rf /tmp/build /root",
            "rm -rf /tmp/../etc/passwd",
            "rm -rf /tmpfoo",
            "rm -rf /tmp/$USER",
            "rm -rf /tmp/*",
            "rm -rf /tmp/`whoami`",
            "rm -rf",
            "rm -rf --",
            "rm -rf -",
        ] {
            assert_eq!(
                analyze_bash_command(dangerous),
                DangerousVerdict::Dangerous("rm -rf".into()),
                "expected dangerous: {dangerous}"
            );
        }
    }

    #[test]
    fn test_rm_rf_and_normalization_commands() {
        assert_eq!(
            analyze_bash_command("/bin/rm -rf ./build"),
            DangerousVerdict::Dangerous("rm -rf".into())
        );
        assert_eq!(
            analyze_bash_command("rm -r -f dist"),
            DangerousVerdict::Dangerous("rm -rf".into())
        );
        assert_eq!(
            analyze_bash_command("rm --recursive --force node_modules"),
            DangerousVerdict::Dangerous("rm -rf".into())
        );
        assert_eq!(
            analyze_bash_command("/sbin/mkfs.ext4 /dev/sdb1"),
            DangerousVerdict::Dangerous("mkfs.ext4".into())
        );
        assert_eq!(
            analyze_bash_command("init 0"),
            DangerousVerdict::Dangerous("init 0".into())
        );
        assert_eq!(
            analyze_bash_command("busybox rm -rf temp"),
            DangerousVerdict::Dangerous("rm -rf".into())
        );
        assert_eq!(
            analyze_bash_command("eval 'rm -rf caches'"),
            DangerousVerdict::Dangerous("rm -rf".into())
        );
        assert_eq!(
            analyze_bash_command("C:\\Windows\\System32\\shutdown.exe /s /t 0"),
            DangerousVerdict::Dangerous("shutdown".into())
        );
    }

    /// Upstream #3869: the shapes v2's tree-sitter analyzer rejects are
    /// unanalyzable in the fork's lexer too — an unbalanced quote and a
    /// command name that is not a literal.
    #[test]
    fn test_unanalyzable_shapes() {
        for cmd in ["echo \"unterminated", "$CMD --force", "sudo $CMD reboot"] {
            assert!(
                matches!(analyze_bash_command(cmd), DangerousVerdict::Unanalyzable(_)),
                "must be unanalyzable: {cmd}"
            );
        }
    }

    /// A dangerous verdict wins over an unanalyzable one: `sudo reboot`
    /// followed by an unterminated quote is still dangerous, never waved
    /// through as merely unreadable.
    #[test]
    fn test_dangerous_wins_over_unanalyzable() {
        assert!(matches!(
            analyze_bash_command("sudo reboot; echo \"unterminated"),
            DangerousVerdict::Dangerous(_)
        ));
    }

    /// A literal command name with variable arguments is analyzable — only
    /// the command NAME being non-literal is unanalyzable (v2 bails on
    /// `bash -c "echo $HOME"` for its own grammar reasons; the fork reads
    /// the inner command, which is a documented residual).
    #[test]
    fn test_variable_arguments_stay_analyzable() {
        assert_eq!(analyze_bash_command("echo $HOME"), DangerousVerdict::Safe);
        assert_eq!(
            analyze_bash_command("bash -c \"echo $HOME\""),
            DangerousVerdict::Safe
        );
    }

    #[test]
    fn test_safe_commands_allowed() {
        assert_eq!(analyze_bash_command("ls -la"), DangerousVerdict::Safe);
        assert_eq!(analyze_bash_command("git status"), DangerousVerdict::Safe);
        assert_eq!(analyze_bash_command("cargo check"), DangerousVerdict::Safe);
        assert_eq!(
            analyze_bash_command("dd if=/dev/zero of=/dev/null bs=1M"),
            DangerousVerdict::Safe
        );
        assert_eq!(analyze_bash_command("rm file.txt"), DangerousVerdict::Safe);
    }
}
