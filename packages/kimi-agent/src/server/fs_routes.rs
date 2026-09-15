//! Advanced filesystem and git routes for native Kimi Agent server.
//!
//! Provides handlers for `fs:git_status`, `fs:diff`, `fs:stat`, `fs:stat_many`,
//! `fs:mkdir`, `fs:list`, and `fs:read`, adhering to kap-server REST conventions.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::server::router::HttpResponse;
use crate::session::sqlite_store::SqliteSessionStore;

/// Resolve effective workspace root path for a given session.
pub fn resolve_session_workdir(store: &SqliteSessionStore, session_id: &str) -> Option<PathBuf> {
    let session = store.get_session(session_id).ok().flatten()?;
    if let Some(ref ws_id) = session.workspace_id
        && let Ok(Some(ws)) = store.get_workspace(ws_id)
    {
        return Some(PathBuf::from(ws.root));
    }
    if let Ok(Some(meta)) = store.get_state("metadata", session_id)
        && let Some(cwd) = meta.get("cwd").and_then(|c| c.as_str())
    {
        return Some(PathBuf::from(cwd));
    }
    std::env::current_dir().ok()
}

/// Helper to sanitize and resolve a path relative to workspace root, preventing directory traversal escapes.
pub fn resolve_safe_path(work_dir: &Path, rel_path: &str) -> Result<PathBuf, HttpResponse> {
    let trimmed = rel_path
        .trim()
        .trim_start_matches('/')
        .trim_start_matches('\\');
    let candidate = work_dir.join(trimmed);
    // If the path exists, canonicalize both and ensure work_dir prefix
    if candidate.exists() {
        let canon_work = work_dir.canonicalize().map_err(|e| {
            HttpResponse::internal_error(format!("Cannot canonicalize work dir: {e}"))
        })?;
        let canon_cand = candidate
            .canonicalize()
            .map_err(|e| HttpResponse::internal_error(format!("Cannot canonicalize path: {e}")))?;
        if !canon_cand.starts_with(&canon_work) {
            return Err(HttpResponse::bad_request("Path escapes session workspace"));
        }
        Ok(canon_cand)
    } else {
        // If not existing yet (e.g. for mkdir), check normalized components
        let mut depth: isize = 0;
        for comp in Path::new(trimmed).components() {
            match comp {
                std::path::Component::ParentDir => {
                    depth -= 1;
                    if depth < 0 {
                        return Err(HttpResponse::bad_request("Path escapes session workspace"));
                    }
                }
                std::path::Component::Normal(_) => {
                    depth += 1;
                }
                _ => {}
            }
        }
        Ok(candidate)
    }
}

/// Format file entry object adhering to FsEntry schema.
pub fn file_to_fs_entry(work_dir: &Path, full_path: &Path) -> Result<Value, std::io::Error> {
    let metadata = full_path.metadata()?;
    let name = full_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let rel_path = full_path
        .strip_prefix(work_dir)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| name.clone());

    let kind = if metadata.is_dir() {
        "directory"
    } else if metadata.is_symlink() {
        "symlink"
    } else {
        "file"
    };

    let modified_millis = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());

    let modified_at = chrono::DateTime::from_timestamp_millis(modified_millis)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default();

    let is_binary = if metadata.is_file() {
        if let Ok(file) = std::fs::File::open(full_path) {
            use std::io::Read;
            let mut buffer = [0u8; 512];
            let mut handle = file.take(512);
            if let Ok(n) = handle.read(&mut buffer) {
                buffer[..n].contains(&0)
            } else {
                false
            }
        } else {
            false
        }
    } else {
        false
    };

    let mut entry = json!({
        "path": rel_path,
        "name": name,
        "kind": kind,
        "size": metadata.len(),
        "modified_at": modified_at,
        "is_binary": is_binary,
    });

    if metadata.is_dir()
        && let Ok(read_dir) = std::fs::read_dir(full_path)
    {
        entry["child_count"] = json!(read_dir.count());
    }

    Ok(entry)
}

/// Handle `fs:git_status` (or `fs:gitStatus`).
pub fn handle_git_status(work_dir: &Path) -> HttpResponse {
    let output = std::process::Command::new("git")
        .args(["status", "--porcelain=v2", "--branch"])
        .current_dir(work_dir)
        .output();

    let Ok(out) = output else {
        return HttpResponse::ok(&json!({
            "branch": "",
            "ahead": 0,
            "behind": 0,
            "entries": {},
            "additions": 0,
            "deletions": 0,
            "pullRequest": Value::Null,
        }));
    };

    if !out.status.success() {
        return HttpResponse::ok(&json!({
            "branch": "",
            "ahead": 0,
            "behind": 0,
            "entries": {},
            "additions": 0,
            "deletions": 0,
            "pullRequest": Value::Null,
        }));
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let mut branch = String::new();
    let mut ahead = 0;
    let mut behind = 0;
    let mut entries = HashMap::new();

    for line in text.lines() {
        if let Some(b) = line.strip_prefix("# branch.head ") {
            if b != "(detached)" {
                branch = b.trim().to_string();
            }
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            for part in ab.split_whitespace() {
                if let Some(a) = part.strip_prefix('+') {
                    ahead = a.parse().unwrap_or(0);
                } else if let Some(b) = part.strip_prefix('-') {
                    behind = b.parse().unwrap_or(0);
                }
            }
        } else if line.starts_with('1') || line.starts_with('2') {
            // e.g. 1 M. N... 100644 100644 100644 ... src/main.rs
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 9 {
                let xy = parts[1];
                let path = parts[8..].join(" ");
                let status = if xy.starts_with('A') {
                    "added"
                } else if xy.starts_with('D') || xy.ends_with('D') {
                    "deleted"
                } else if xy.starts_with('R') {
                    "renamed"
                } else {
                    "modified"
                };
                entries.insert(path, json!({ "status": status }));
            }
        } else if line.starts_with('?') {
            // Untracked: ? src/new_file.rs
            if let Some(path) = line.strip_prefix("? ") {
                entries.insert(path.trim().to_string(), json!({ "status": "untracked" }));
            }
        } else if line.starts_with('u') {
            // Unmerged: u ...
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 11 {
                let path = parts[10..].join(" ");
                entries.insert(path, json!({ "status": "conflict" }));
            }
        }
    }

    let mut additions = 0;
    let mut deletions = 0;
    if let Ok(stat_out) = std::process::Command::new("git")
        .args(["diff", "--numstat", "HEAD"])
        .current_dir(work_dir)
        .output()
        && stat_out.status.success()
    {
        let stat_str = String::from_utf8_lossy(&stat_out.stdout);
        for line in stat_str.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                if let Ok(add) = parts[0].parse::<usize>() {
                    additions += add;
                }
                if let Ok(del) = parts[1].parse::<usize>() {
                    deletions += del;
                }
            }
        }
    }

    HttpResponse::ok(&json!({
        "branch": branch,
        "ahead": ahead,
        "behind": behind,
        "entries": entries,
        "additions": additions,
        "deletions": deletions,
        "pullRequest": Value::Null,
    }))
}

/// Handle `fs:diff`.
pub fn handle_diff(work_dir: &Path, body: &Value) -> HttpResponse {
    let rel_path = match body.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p.trim(),
        _ => return HttpResponse::bad_request("Field 'path' is required"),
    };

    let target_path = match resolve_safe_path(work_dir, rel_path) {
        Ok(p) => p,
        Err(resp) => return resp,
    };

    // 1. Try git diff HEAD -- <path>
    let output = std::process::Command::new("git")
        .args(["diff", "HEAD", "--", rel_path])
        .current_dir(work_dir)
        .output();

    if let Ok(out) = output
        && out.status.success()
        && !out.stdout.is_empty()
    {
        let diff_str = String::from_utf8_lossy(&out.stdout).to_string();
        return HttpResponse::ok(&json!({
            "path": rel_path,
            "diff": diff_str,
            "truncated": false,
        }));
    }

    // 2. If git diff was empty or file is untracked, synthesize diff if file exists
    if target_path.is_file()
        && let Ok(content) = std::fs::read_to_string(&target_path)
    {
        let line_count = content.lines().count();
        let mut diff = format!("--- /dev/null\n+++ b/{rel_path}\n@@ -0,0 +1,{line_count} @@\n");
        for line in content.lines() {
            diff.push('+');
            diff.push_str(line);
            diff.push('\n');
        }
        return HttpResponse::ok(&json!({
            "path": rel_path,
            "diff": diff,
            "truncated": false,
        }));
    }

    HttpResponse::ok(&json!({
        "path": rel_path,
        "diff": "",
        "truncated": false,
    }))
}

/// Handle `fs:stat`.
pub fn handle_stat(work_dir: &Path, body: &Value) -> HttpResponse {
    let rel_path = match body.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p.trim(),
        _ => return HttpResponse::bad_request("Field 'path' is required"),
    };

    let target = match resolve_safe_path(work_dir, rel_path) {
        Ok(p) => p,
        Err(resp) => return resp,
    };

    if !target.exists() {
        return HttpResponse::not_found();
    }

    match file_to_fs_entry(work_dir, &target) {
        Ok(entry) => HttpResponse::ok(&entry),
        Err(e) => HttpResponse::internal_error(format!("Failed to stat file: {e}")),
    }
}

/// Handle `fs:stat_many` (or `fs:statMany`).
pub fn handle_stat_many(work_dir: &Path, body: &Value) -> HttpResponse {
    let paths = match body.get("paths").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return HttpResponse::bad_request("Field 'paths' must be an array of strings"),
    };

    let mut entries = HashMap::new();
    for p_val in paths {
        if let Some(p_str) = p_val.as_str() {
            if let Ok(target) = resolve_safe_path(work_dir, p_str)
                && target.exists()
                && let Ok(entry) = file_to_fs_entry(work_dir, &target)
            {
                entries.insert(p_str.to_string(), entry);
            } else {
                entries.insert(p_str.to_string(), Value::Null);
            }
        }
    }

    HttpResponse::ok(&json!({ "entries": entries }))
}

/// Handle `fs:mkdir`.
pub fn handle_mkdir(work_dir: &Path, body: &Value) -> HttpResponse {
    let rel_path = match body.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p.trim(),
        _ => return HttpResponse::bad_request("Field 'path' is required"),
    };
    let recursive = body
        .get("recursive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let target = match resolve_safe_path(work_dir, rel_path) {
        Ok(p) => p,
        Err(resp) => return resp,
    };

    let create_res = if recursive {
        std::fs::create_dir_all(&target)
    } else {
        std::fs::create_dir(&target)
    };

    if let Err(e) = create_res {
        return HttpResponse::internal_error(format!("Failed to create directory: {e}"));
    }

    match file_to_fs_entry(work_dir, &target) {
        Ok(entry) => HttpResponse::json(201, &entry),
        Err(e) => HttpResponse::internal_error(format!("Failed to stat created directory: {e}")),
    }
}

/// Handle `fs:list`.
pub fn handle_list(work_dir: &Path, body: &Value) -> HttpResponse {
    let rel_path = body
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    let target = match resolve_safe_path(work_dir, rel_path) {
        Ok(p) => p,
        Err(resp) => return resp,
    };

    if !target.is_dir() {
        return HttpResponse::bad_request("Target path is not a directory");
    }

    let mut entries = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(&target) {
        for entry in read_dir.flatten() {
            if let Ok(fs_entry) = file_to_fs_entry(work_dir, &entry.path()) {
                entries.push(fs_entry);
            }
        }
    }

    entries.sort_by(|a, b| {
        let is_dir_a = a["kind"] == "directory";
        let is_dir_b = b["kind"] == "directory";
        if is_dir_a != is_dir_b {
            is_dir_b.cmp(&is_dir_a)
        } else {
            let name_a = a["name"].as_str().unwrap_or_default().to_lowercase();
            let name_b = b["name"].as_str().unwrap_or_default().to_lowercase();
            name_a.cmp(&name_b)
        }
    });

    HttpResponse::ok(&json!({
        "items": entries.clone(),
        "entries": entries,
        "truncated": false,
    }))
}

/// Handle `fs:list_many` (or `fs:listMany`).
pub fn handle_list_many(work_dir: &Path, body: &Value) -> HttpResponse {
    let paths = match body.get("paths").and_then(|v| v.as_array()) {
        Some(p) => p,
        None => return HttpResponse::bad_request("Field 'paths' must be an array of strings"),
    };

    let mut results = HashMap::new();
    for p_val in paths {
        if let Some(rel_path) = p_val.as_str() {
            if let Ok(target) = resolve_safe_path(work_dir, rel_path) {
                if target.is_dir() {
                    let mut items = Vec::new();
                    if let Ok(read_dir) = std::fs::read_dir(&target) {
                        for entry in read_dir.flatten() {
                            if let Ok(fs_entry) = file_to_fs_entry(work_dir, &entry.path()) {
                                items.push(fs_entry);
                            }
                        }
                    }
                    results.insert(rel_path.to_string(), json!(items));
                } else {
                    results.insert(rel_path.to_string(), json!([]));
                }
            } else {
                results.insert(rel_path.to_string(), json!([]));
            }
        }
    }

    HttpResponse::ok(&json!({ "results": results }))
}

/// Handle `fs:read`.
pub fn handle_read(work_dir: &Path, body: &Value) -> HttpResponse {
    let rel_path = match body.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p.trim(),
        _ => return HttpResponse::bad_request("Field 'path' is required"),
    };

    let target = match resolve_safe_path(work_dir, rel_path) {
        Ok(p) => p,
        Err(resp) => return resp,
    };

    if !target.exists() {
        return HttpResponse::not_found();
    }

    if !target.is_file() {
        return HttpResponse::bad_request("Target is not a regular file");
    }

    let offset = body.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let length = body
        .get("length")
        .and_then(|v| v.as_u64())
        .unwrap_or(1_048_576) as usize;

    let content_bytes = match std::fs::read(&target) {
        Ok(b) => b,
        Err(e) => return HttpResponse::internal_error(format!("Failed to read file: {e}")),
    };

    let total_size = content_bytes.len();
    let is_binary = content_bytes.iter().take(512).any(|&b| b == 0);

    let (slice, truncated) = if offset >= total_size {
        (&[][..], false)
    } else {
        let end = (offset + length).min(total_size);
        (&content_bytes[offset..end], end < total_size)
    };

    let content_str = String::from_utf8_lossy(slice).to_string();

    let mime = if is_binary {
        "application/octet-stream"
    } else if rel_path.ends_with(".json") {
        "application/json"
    } else {
        "text/plain"
    };

    let etag = format!("\"{:x}-{:x}\"", total_size, total_size ^ offset);

    HttpResponse::ok(&json!({
        "path": rel_path,
        "content": content_str,
        "encoding": "utf-8",
        "size": total_size,
        "truncated": truncated,
        "etag": etag,
        "mime": mime,
        "is_binary": is_binary,
    }))
}

/// Handle `fs:search`.
pub fn handle_search(work_dir: &Path, body: &Value) -> HttpResponse {
    let query = body
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let limit = body.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;

    let mut items = Vec::new();
    if query.is_empty() {
        if let Ok(read_dir) = std::fs::read_dir(work_dir) {
            for entry in read_dir.flatten() {
                if let Ok(fs_entry) = file_to_fs_entry(work_dir, &entry.path()) {
                    let path = fs_entry["path"].as_str().unwrap_or_default().to_string();
                    let name = fs_entry["name"].as_str().unwrap_or_default().to_string();
                    let kind = fs_entry["kind"].as_str().unwrap_or("file").to_string();
                    items.push(json!({
                        "path": path,
                        "name": name,
                        "kind": kind,
                    }));
                }
                if items.len() >= limit {
                    break;
                }
            }
        }
    } else {
        let git_ls = std::process::Command::new("git")
            .args(["ls-files", "--cached", "--others", "--exclude-standard"])
            .current_dir(work_dir)
            .output();

        let q_lower = query.to_lowercase();
        if let Ok(out) = git_ls
            && out.status.success()
        {
            let files_str = String::from_utf8_lossy(&out.stdout);
            for line in files_str.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if trimmed.to_lowercase().contains(&q_lower) {
                    let path = trimmed.replace('\\', "/");
                    let name = Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| path.clone());
                    let size = std::fs::metadata(work_dir.join(&path))
                        .map(|m| m.len())
                        .unwrap_or(0);
                    items.push(json!({
                        "path": path,
                        "name": name,
                        "kind": "file",
                        "size": size,
                    }));
                    if items.len() >= limit {
                        break;
                    }
                }
            }
        } else {
            let mut stack = vec![work_dir.to_path_buf()];
            while let Some(dir) = stack.pop() {
                if let Ok(read_dir) = std::fs::read_dir(&dir) {
                    for entry in read_dir.flatten() {
                        let path = entry.path();
                        if path.is_dir() {
                            let name = entry.file_name().to_string_lossy().to_string();
                            if !name.starts_with('.') && name != "node_modules" && name != "target"
                            {
                                stack.push(path);
                            }
                        } else if path.is_file() {
                            let rel = path
                                .strip_prefix(work_dir)
                                .unwrap_or(&path)
                                .to_string_lossy()
                                .replace('\\', "/");
                            if rel.to_lowercase().contains(&q_lower) {
                                let name = entry.file_name().to_string_lossy().to_string();
                                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                                items.push(json!({
                                    "path": rel,
                                    "name": name,
                                    "kind": "file",
                                    "size": size,
                                }));
                                if items.len() >= limit {
                                    break;
                                }
                            }
                        }
                    }
                }
                if items.len() >= limit {
                    break;
                }
            }
        }
    }

    HttpResponse::ok(&json!({
        "items": items,
        "truncated": items.len() >= limit,
    }))
}

/// Handle `fs:grep`.
pub fn handle_grep(work_dir: &Path, body: &Value) -> HttpResponse {
    let pattern = match body.get("pattern").and_then(|v| v.as_str()) {
        Some(p) if !p.is_empty() => p,
        _ => return HttpResponse::bad_request("Field 'pattern' is required"),
    };
    let case_sensitive = body
        .get("case_sensitive")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let is_regex = body.get("regex").and_then(|v| v.as_bool()).unwrap_or(false);
    let max_files = body
        .get("max_files")
        .and_then(|v| v.as_u64())
        .unwrap_or(200) as usize;

    let start_time = std::time::Instant::now();

    let mut args = vec!["grep", "-n", "-I"];
    if !case_sensitive {
        args.push("-i");
    }
    if is_regex {
        args.push("-E");
    } else {
        args.push("-F");
    }
    args.push("-e");
    args.push(pattern);
    args.push("--");
    args.push(".");

    let output = std::process::Command::new("git")
        .args(&args)
        .current_dir(work_dir)
        .output();

    let mut file_hits: HashMap<String, Vec<Value>> = HashMap::new();
    let mut files_scanned = 0;

    if let Ok(out) = output
        && (out.status.success() || out.status.code() == Some(1))
    {
        let stdout_str = String::from_utf8_lossy(&out.stdout);
        for line in stdout_str.lines() {
            let parts: Vec<&str> = line.splitn(3, ':').collect();
            if parts.len() == 3 {
                let file = parts[0].replace('\\', "/");
                let line_num = parts[1].parse::<usize>().unwrap_or(1);
                let content = parts[2];

                let hits = file_hits.entry(file).or_default();
                hits.push(json!({
                    "line_number": line_num,
                    "line_content": content,
                }));
            }
        }
        files_scanned = file_hits.len();
    }

    let truncated = file_hits.len() > max_files;
    let mut files: Vec<Value> = file_hits
        .into_iter()
        .take(max_files)
        .map(|(path, hits)| {
            json!({
                "path": path,
                "hits": hits,
            })
        })
        .collect();
    files.sort_by(|a, b| {
        a["path"]
            .as_str()
            .unwrap_or("")
            .cmp(b["path"].as_str().unwrap_or(""))
    });

    let elapsed_ms = start_time.elapsed().as_millis() as usize;

    HttpResponse::ok(&json!({
        "files": files,
        "files_scanned": files_scanned,
        "truncated": truncated,
        "elapsed_ms": elapsed_ms,
    }))
}

/// Handle `fs:open`: launch the resolved file in the user's editor (or the
/// platform opener) and report the real outcome. Previously this discarded the
/// resolved path and answered `{"opened": true}` without launching anything.
pub fn handle_open(work_dir: &Path, body: &Value) -> HttpResponse {
    let rel_path = match body.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p.trim(),
        _ => return HttpResponse::bad_request("Field 'path' is required"),
    };
    let target = match resolve_safe_path(work_dir, rel_path) {
        Ok(t) => t,
        Err(resp) => return resp,
    };
    let line = body.get("line").and_then(|v| v.as_u64());
    match crate::server::file_launch::open_file(&target, line) {
        Ok(()) => HttpResponse::ok(&json!({ "opened": true })),
        Err(error) => HttpResponse::internal_error(error),
    }
}

/// Handle `fs:reveal`: select the resolved file in the platform file manager.
pub fn handle_reveal(work_dir: &Path, body: &Value) -> HttpResponse {
    let rel_path = match body.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p.trim(),
        _ => return HttpResponse::bad_request("Field 'path' is required"),
    };
    let target = match resolve_safe_path(work_dir, rel_path) {
        Ok(t) => t,
        Err(resp) => return resp,
    };
    match crate::server::file_launch::reveal_file(&target) {
        Ok(()) => HttpResponse::ok(&json!({ "revealed": true })),
        Err(error) => HttpResponse::internal_error(error),
    }
}

/// Handle `fs:open-in`: open the resolved path in the requested app
/// (v2 `OpenInAppId`: finder / cursor / vscode / iterm / terminal).
pub fn handle_open_in(work_dir: &Path, body: &Value) -> HttpResponse {
    let rel_path = match body.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p.trim(),
        _ => return HttpResponse::bad_request("Field 'path' is required"),
    };
    let app = match body.get("app").and_then(|v| v.as_str()) {
        Some(a) if !a.trim().is_empty() => a.trim(),
        _ => return HttpResponse::bad_request("Field 'app' is required"),
    };
    let target = match resolve_safe_path(work_dir, rel_path) {
        Ok(t) => t,
        Err(resp) => return resp,
    };
    let line = body.get("line").and_then(|v| v.as_u64());
    match crate::server::file_launch::open_in_app(app, &target, line) {
        Ok(()) => HttpResponse::ok(&json!({ "opened": true })),
        Err(error) => HttpResponse::internal_error(error),
    }
}

/// The `fs:open-in` app ids available on this machine (v2
/// `getAvailableOpenInApps`).
pub fn handle_open_in_apps(_body: &Value) -> HttpResponse {
    let apps: Vec<&str> = crate::server::file_launch::OPEN_IN_APP_IDS
        .iter()
        .copied()
        .filter(|id| crate::server::file_launch::is_open_in_app_available(id))
        .collect();
    HttpResponse::ok(&json!({ "apps": apps }))
}

/// Content-Type for a served file, from its extension. Deliberately small:
/// the caller (web UI) renders text itself, and `application/octet-stream` is
/// the honest fallback for everything the map does not know.
fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some(
            "txt" | "md" | "log" | "json" | "toml" | "yaml" | "yml" | "csv" | "rs" | "ts" | "tsx"
            | "js" | "jsx" | "mjs" | "cjs" | "py" | "go" | "java" | "c" | "h" | "cpp" | "html"
            | "css" | "sh",
        ) => "text/plain; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Handle `fs::content` — serve the raw bytes of a host file by **absolute**
/// path (kap-server `fsContentQuerySchema`): `path` is required and must be
/// absolute, the response is raw bytes with an ETag, `If-None-Match` yields a
/// 304, and a single `Range: bytes=a-b` request yields a 206 slice.
///
/// Like `fs:home` / `fs:browse` this is a whole-host surface by design; the
/// bearer auth at the HTTP layer is what gates it.
pub fn handle_fs_content(
    query_path: Option<&str>,
    if_none_match: Option<&str>,
    range: Option<&str>,
) -> HttpResponse {
    use std::time::UNIX_EPOCH;

    let Some(raw_path) = query_path.map(str::trim).filter(|p| !p.is_empty()) else {
        return HttpResponse::bad_request("Query parameter 'path' is required");
    };
    let path = Path::new(raw_path);
    if !path.is_absolute() {
        return HttpResponse::bad_request("Query parameter 'path' must be an absolute path");
    }
    let Ok(meta) = std::fs::metadata(path) else {
        return HttpResponse::json(
            404,
            &json!({ "error": "FS_PATH_NOT_FOUND", "path": raw_path }),
        );
    };
    if meta.is_dir() {
        return HttpResponse::bad_request("FS_IS_DIRECTORY");
    }
    let len = meta.len() as usize;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let etag = format!("\"{mtime_ms:x}-{len:x}\"");

    if let Some(inm) = if_none_match
        && inm.split(',').any(|tag| tag.trim() == etag)
    {
        return HttpResponse::json(304, &Value::Null).with_header("ETag", etag.clone());
    }

    let Ok(bytes) = std::fs::read(path) else {
        return HttpResponse::internal_error(format!("failed to read {raw_path}"));
    };

    // Single-range request (`bytes=a-b`, `bytes=a-`, `bytes=-suffix`). Anything
    // else (multiple ranges, units other than bytes) is served in full, which
    // is what a client that ignores 206 semantics expects anyway.
    let range = range
        .filter(|r| r.starts_with("bytes="))
        .and_then(|r| r["bytes=".len()..].split(',').next().map(str::to_string));
    if let Some(spec) = range.as_deref() {
        let (start_str, end_str) = match spec.split_once('-') {
            Some(pair) => pair,
            None => return HttpResponse::bad_request("Malformed Range header"),
        };
        let parsed = match (start_str.parse::<usize>(), end_str.parse::<usize>()) {
            (Ok(start), Ok(end)) if start <= end && end < len => Some((start, end)),
            (Ok(start), Err(_)) if start < len => Some((start, len - 1)),
            (Err(_), Ok(suffix)) if suffix > 0 => {
                Some((len.saturating_sub(suffix), len.saturating_sub(1)))
            }
            _ => None,
        };
        if let Some((start, end)) = parsed {
            let slice = bytes[start..=end].to_vec();
            let mut resp = HttpResponse::json(206, &Value::Null);
            resp.body = slice;
            resp.headers
                .insert("Content-Type".into(), content_type_for(path).into());
            resp.headers
                .insert("Content-Range".into(), format!("bytes {start}-{end}/{len}"));
            resp.headers.insert("Accept-Ranges".into(), "bytes".into());
            resp.headers.insert("ETag".into(), etag);
            return resp;
        }
    }

    let mut resp = HttpResponse::json(200, &Value::Null);
    resp.body = bytes;
    resp.headers
        .insert("Content-Type".into(), content_type_for(path).into());
    resp.headers.insert("Accept-Ranges".into(), "bytes".into());
    resp.headers.insert("ETag".into(), etag);
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_safe_path_boundaries() {
        let temp_dir = tempfile::tempdir().unwrap();
        let root = temp_dir.path();

        let sub_file = root.join("hello.txt");
        std::fs::write(&sub_file, "world").unwrap();

        // Normal path resolves
        let safe = resolve_safe_path(root, "hello.txt").unwrap();
        assert_eq!(safe, sub_file.canonicalize().unwrap());

        // Escape path rejected
        assert!(resolve_safe_path(root, "../outside.txt").is_err());
    }

    #[test]
    fn test_file_to_fs_entry_stat() {
        let temp_dir = tempfile::tempdir().unwrap();
        let root = temp_dir.path();

        let sub_file = root.join("demo.txt");
        std::fs::write(&sub_file, "abc").unwrap();

        let entry = file_to_fs_entry(root, &sub_file).unwrap();
        assert_eq!(entry["name"], "demo.txt");
        assert_eq!(entry["kind"], "file");
        assert_eq!(entry["size"], 3);
        assert_eq!(entry["is_binary"], false);
    }

    #[test]
    fn test_fs_handlers_crud() {
        let temp_dir = tempfile::tempdir().unwrap();
        let root = temp_dir.path();

        // 1. mkdir
        let mkdir_res = handle_mkdir(root, &json!({ "path": "src/subdir", "recursive": true }));
        assert_eq!(mkdir_res.status, 201);

        // 2. write a file
        let file_path = root.join("src/subdir/test.txt");
        std::fs::write(&file_path, "Hello Kimi!").unwrap();

        // 3. stat
        let stat_res = handle_stat(root, &json!({ "path": "src/subdir/test.txt" }));
        assert_eq!(stat_res.status, 200);
        let stat_json: Value = serde_json::from_slice(&stat_res.body).unwrap();
        assert_eq!(stat_json["name"], "test.txt");
        assert_eq!(stat_json["size"], 11);

        // 4. stat_many
        let stat_many_res = handle_stat_many(
            root,
            &json!({ "paths": ["src/subdir/test.txt", "nonexistent.txt"] }),
        );
        assert_eq!(stat_many_res.status, 200);
        let stat_many_json: Value = serde_json::from_slice(&stat_many_res.body).unwrap();
        assert!(stat_many_json["entries"]["src/subdir/test.txt"].is_object());
        assert!(stat_many_json["entries"]["nonexistent.txt"].is_null());

        // 5. read
        let read_res = handle_read(root, &json!({ "path": "src/subdir/test.txt" }));
        assert_eq!(read_res.status, 200);
        let read_json: Value = serde_json::from_slice(&read_res.body).unwrap();
        assert_eq!(read_json["content"], "Hello Kimi!");
        assert_eq!(read_json["size"], 11);
        assert_eq!(read_json["truncated"], false);

        // 6. list & list_many
        let list_res = handle_list(root, &json!({ "path": "src/subdir" }));
        assert_eq!(list_res.status, 200);
        let list_json: Value = serde_json::from_slice(&list_res.body).unwrap();
        assert_eq!(list_json["items"].as_array().unwrap().len(), 1);

        let list_many_res = handle_list_many(root, &json!({ "paths": ["src/subdir"] }));
        assert_eq!(list_many_res.status, 200);
        let list_many_json: Value = serde_json::from_slice(&list_many_res.body).unwrap();
        assert_eq!(
            list_many_json["results"]["src/subdir"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        // 7. search
        let search_res = handle_search(root, &json!({ "query": "test" }));
        assert_eq!(search_res.status, 200);
        let search_json: Value = serde_json::from_slice(&search_res.body).unwrap();
        let items = search_json["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["name"], "test.txt");
        assert_eq!(items[0]["path"], "src/subdir/test.txt");
        assert_eq!(items[0]["kind"], "file");
        assert_eq!(items[0]["size"], 11);
        assert_eq!(search_json["truncated"], false);

        // 8. diff
        let diff_res = handle_diff(root, &json!({ "path": "src/subdir/test.txt" }));
        assert_eq!(diff_res.status, 200);
        let diff_json: Value = serde_json::from_slice(&diff_res.body).unwrap();
        assert!(diff_json["diff"].as_str().unwrap().contains("+Hello Kimi!"));

        // 9. git_status returns standard structure
        let git_res = handle_git_status(root);
        assert_eq!(git_res.status, 200);
        let git_json: Value = serde_json::from_slice(&git_res.body).unwrap();
        assert!(git_json.get("branch").is_some());
        assert_eq!(git_json["ahead"], 0);
        assert_eq!(git_json["behind"], 0);
        assert!(git_json["entries"].is_object());

        // 10. open & reveal
        let open_res = handle_open(root, &json!({ "path": "src/subdir/test.txt" }));
        assert_eq!(open_res.status, 200);
        let open_val: Value = serde_json::from_slice(&open_res.body).unwrap();
        assert_eq!(open_val["opened"], true);

        let reveal_res = handle_reveal(root, &json!({ "path": "src/subdir/test.txt" }));
        assert_eq!(reveal_res.status, 200);
        let reveal_val: Value = serde_json::from_slice(&reveal_res.body).unwrap();
        assert_eq!(reveal_val["revealed"], true);

        // Required path validation on open and reveal
        assert_eq!(handle_open(root, &json!({})).status, 400);
        assert_eq!(handle_reveal(root, &json!({})).status, 400);

        // 11. grep handler
        assert_eq!(handle_grep(root, &json!({})).status, 400);
        assert_eq!(handle_grep(root, &json!({ "pattern": "" })).status, 400);
        let grep_res = handle_grep(root, &json!({ "pattern": "Hello" }));
        assert_eq!(grep_res.status, 200);
        let grep_json: Value = serde_json::from_slice(&grep_res.body).unwrap();
        assert!(grep_json["files"].is_array());
        assert_eq!(grep_json["truncated"], false);

        // 12. read error cases
        assert_eq!(handle_read(root, &json!({})).status, 400);
        assert_eq!(
            handle_read(root, &json!({ "path": "../outside.txt" })).status,
            400
        );
        assert_eq!(
            handle_read(root, &json!({ "path": "non-existent.txt" })).status,
            404
        );
    }
}
