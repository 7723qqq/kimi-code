//! 原生危险命令词法分析器（对齐 TS dangerous-command-ask.ts 366行）。
//!
//! 负责分析 Bash 命令行，检测关机、重启、格式化、dd 物理设备覆盖、
//! 以及透过 sudo / doas / nohup / bash -c 等包装的高危破坏性指令。

pub const SIMPLE_DANGEROUS_COMMANDS: &[&str] = &[
    "shutdown", "halt", "poweroff", "reboot", "bcdedit", "diskpart",
    "format", "restart-computer", "stop-computer", "mkfs", "wipefs",
];

pub const PRIVILEGE_WRAPPERS: &[&str] = &["sudo", "doas"];

pub const PRIVILEGE_VALUE_OPTIONS: &[&str] = &[
    "-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt",
    "-C", "--close-from", "-T", "--command-timeout", "-U", "--other-user",
    "-r", "--role", "-t", "--type",
];

pub const LAUNCH_WRAPPERS: &[&str] = &[
    "env", "command", "exec", "nohup", "builtin", "nice",
];

pub const WRAPPER_VALUE_OPTIONS: &[&str] = &[
    "-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "-n", "--adjustment",
];

pub const NESTED_SHELLS: &[&str] = &["sh", "bash", "dash", "zsh", "ksh", "ash"];

pub const SYSTEMCTL_DANGEROUS_SUBCOMMANDS: &[&str] = &[
    "poweroff", "reboot", "halt", "kexec",
];

#[derive(Debug, PartialEq, Eq)]
pub enum DangerousVerdict {
    Dangerous(String),
    Safe,
}

/// 分析复合 Bash 脚本或单条命令是否包含破坏性指令
pub fn analyze_bash_command(raw_command: &str) -> DangerousVerdict {
    for sub_cmd in split_pipeline_commands(raw_command) {
        if let DangerousVerdict::Dangerous(cmd) = check_single_command(&sub_cmd) {
            return DangerousVerdict::Dangerous(cmd);
        }
    }
    DangerousVerdict::Safe
}

fn split_pipeline_commands(cmd: &str) -> Vec<String> {
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
    results
}

/// 归一化命令名称：剥离路径前缀与 Windows .exe 后缀
pub fn normalize_command_name(raw: &str) -> String {
    let mut name = raw;
    if let Some(pos) = name.rfind(|c| c == '/' || c == '\\') {
        name = &name[pos + 1..];
    }
    let mut lower = name.to_ascii_lowercase();
    if lower.ends_with(".exe") {
        lower.truncate(lower.len() - 4);
    }
    lower
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
                if !sub.starts_with('-') && SYSTEMCTL_DANGEROUS_SUBCOMMANDS.contains(&norm_sub.as_str()) {
                    return DangerousVerdict::Dangerous(format!("systemctl {}", sub));
                }
            }
        }

        // 4. dd 物理存储设备覆写拦截
        if first == "dd" {
            for arg in &current_tokens[1..] {
                if let Some(target) = arg.strip_prefix("of=") {
                    if target.starts_with("/dev/sd")
                        || target.starts_with("/dev/nvme")
                        || target.starts_with("/dev/hd")
                        || target == "/dev/sda"
                    {
                        return DangerousVerdict::Dangerous(format!("dd of={}", target));
                    }
                }
            }
        }

        // 5. rm -rf 危险删除拦截 (对齐 TS dangerous-command-ask rm 递归强制规范)
        if first == "rm" {
            let mut recursive = false;
            let mut force = false;
            for arg in &current_tokens[1..] {
                if arg == "--" {
                    break;
                }
                if arg == "--recursive" {
                    recursive = true;
                } else if arg == "--force" {
                    force = true;
                } else if arg.starts_with('-') && !arg.starts_with("--") {
                    if arg.contains('r') || arg.contains('R') {
                        recursive = true;
                    }
                    if arg.contains('f') {
                        force = true;
                    }
                }
            }
            if recursive && force {
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
        if PRIVILEGE_WRAPPERS.contains(&first.as_str()) || LAUNCH_WRAPPERS.contains(&first.as_str()) {
            let mut next_cmd_idx = 1;
            while next_cmd_idx < current_tokens.len() {
                let opt = &current_tokens[next_cmd_idx];
                if opt == "--" {
                    next_cmd_idx += 1;
                    break;
                }
                if opt.starts_with('-') {
                    if PRIVILEGE_VALUE_OPTIONS.contains(&opt.as_str()) || WRAPPER_VALUE_OPTIONS.contains(&opt.as_str()) {
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
        if NESTED_SHELLS.contains(&first.as_str()) {
            if let Some(pos) = current_tokens.iter().position(|t| t == "-c") {
                if pos + 1 < current_tokens.len() {
                    return analyze_bash_command(&current_tokens[pos + 1]);
                }
            }
        }

        break;
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

    #[test]
    fn test_safe_commands_allowed() {
        assert_eq!(analyze_bash_command("ls -la"), DangerousVerdict::Safe);
        assert_eq!(analyze_bash_command("git status"), DangerousVerdict::Safe);
        assert_eq!(analyze_bash_command("cargo check"), DangerousVerdict::Safe);
        assert_eq!(analyze_bash_command("dd if=/dev/zero of=/dev/null bs=1M"), DangerousVerdict::Safe);
        assert_eq!(analyze_bash_command("rm file.txt"), DangerousVerdict::Safe);
    }
}
