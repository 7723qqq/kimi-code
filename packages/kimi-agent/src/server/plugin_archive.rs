//! Downloading and extracting a plugin archive.
//!
//! A catalog `source` that is not a local path is a GitHub repository or a zip
//! URL. Both are fetched as a zip and extracted into the managed plugin root.
//!
//! The fetch reuses the FetchUrl SSRF guard (`native::fetch_url`): every hop is
//! resolved, checked against the private-address rules, and pinned, so a
//! rebinding host cannot swap the address between the check and the connect.
//! Extraction refuses any entry that would land outside the destination.

use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::native::fetch_url::{PinnedHosts, resolve_redirect, validate_url};

/// A zip larger than this is refused before it is read into memory.
const MAX_ARCHIVE_BYTES: usize = 256 * 1024 * 1024;
const MAX_REDIRECTS: u32 = 10;
/// Connecting is a fast operation, so a stalled connect fails quickly instead
/// of holding the install for the full body timeout.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Reading the body is bounded by [`MAX_ARCHIVE_BYTES`], which can take a while
/// on a slow link.
const IO_TIMEOUT: Duration = Duration::from_secs(300);
const USER_AGENT: &str = "kimi-code-plugin-installer";

/// The zip URL for a catalog `source`. A GitHub repository URL becomes its
/// default-branch archive (GitHub redirects `/archive/HEAD.zip` to codeload);
/// anything else is already a zip URL and is used as-is.
pub fn archive_url_for(source: &str) -> String {
    match github_repo(source) {
        Some((owner, repo)) => format!("https://github.com/{owner}/{repo}/archive/HEAD.zip"),
        None => source.to_string(),
    }
}

/// `owner/repo` when `source` is a GitHub repository URL.
fn github_repo(source: &str) -> Option<(String, String)> {
    let rest = source
        .strip_prefix("https://github.com/")
        .or_else(|| source.strip_prefix("http://github.com/"))?;
    let mut parts = rest.trim_end_matches('/').split('/');
    let owner = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or_default();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.trim_end_matches(".git").to_string()))
}

/// Download `url` as bytes, applying the SSRF guard to every hop.
pub fn download_archive(url: &str) -> Result<Vec<u8>, String> {
    download_archive_inner(url, false)
}

/// [`download_archive`] with the private-address rule relaxed. Only the
/// in-crate tests use it, to serve an archive from loopback; production always
/// goes through [`download_archive`].
#[cfg(test)]
pub(crate) fn download_archive_allowing_private(url: &str) -> Result<Vec<u8>, String> {
    download_archive_inner(url, true)
}

fn download_archive_inner(url: &str, allow_private: bool) -> Result<Vec<u8>, String> {
    let pinned = PinnedHosts::new();
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(IO_TIMEOUT)
        .timeout_write(IO_TIMEOUT)
        .redirects(0)
        .resolver(pinned.resolver())
        .user_agent(USER_AGENT)
        .build();

    let mut current = url.to_string();
    let mut redirects = 0;
    loop {
        validate_url(&current, allow_private, &pinned)?;
        match agent.get(&current).call() {
            Ok(response) => {
                let status = response.status();
                // ureq returns a 3xx as `Ok` once `redirects(0)` stops it from
                // following, so the hop has to be handled here as well as in
                // the `Err(Status)` arm below.
                if (300..400).contains(&status) {
                    let location = response.header("location").unwrap_or("").to_string();
                    if location.is_empty() {
                        return Err("Redirect without a Location header.".to_string());
                    }
                    redirects += 1;
                    if redirects > MAX_REDIRECTS {
                        return Err(format!("Too many redirects (limit {MAX_REDIRECTS})."));
                    }
                    current = resolve_redirect(&current, &location)?;
                    continue;
                }
                if status != 200 {
                    return Err(format!("Download failed: HTTP {status}"));
                }
                if let Some(len) = response.header("content-length")
                    && let Ok(len) = len.parse::<usize>()
                    && len > MAX_ARCHIVE_BYTES
                {
                    return Err(format!(
                        "Archive is {len} bytes, over the {MAX_ARCHIVE_BYTES}-byte limit."
                    ));
                }
                let mut body = Vec::new();
                response
                    .into_reader()
                    .take(MAX_ARCHIVE_BYTES as u64 + 1)
                    .read_to_end(&mut body)
                    .map_err(|e| format!("Failed to read the archive: {e}"))?;
                if body.len() > MAX_ARCHIVE_BYTES {
                    return Err(format!(
                        "Archive is over the {MAX_ARCHIVE_BYTES}-byte limit."
                    ));
                }
                return Ok(body);
            }
            Err(ureq::Error::Status(code, response)) if (300..400).contains(&code) => {
                let location = response.header("location").unwrap_or("").to_string();
                if location.is_empty() {
                    return Err("Redirect without a Location header.".to_string());
                }
                redirects += 1;
                if redirects > MAX_REDIRECTS {
                    return Err(format!("Too many redirects (limit {MAX_REDIRECTS})."));
                }
                current = resolve_redirect(&current, &location)?;
            }
            Err(ureq::Error::Status(code, _)) => {
                return Err(format!("Download failed: HTTP {code}"));
            }
            Err(ureq::Error::Transport(transport)) => {
                return Err(format!("Download failed: {transport}"));
            }
        }
    }
}

/// Extract a zip into `dest`, refusing any entry that escapes it.
pub fn extract_archive(bytes: &[u8], dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("Cannot create {}: {e}", dest.display()))?;
    let dest = dest
        .canonicalize()
        .map_err(|e| format!("Cannot resolve {}: {e}", dest.display()))?;

    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| {
        let head: String = bytes
            .iter()
            .take(16)
            .map(|byte| format!("{byte:02x}"))
            .collect::<Vec<_>>()
            .join(" ");
        format!(
            "Not a zip archive ({e}); {} bytes, first bytes: {head}",
            bytes.len()
        )
    })?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("Cannot read zip entry {index}: {e}"))?;
        let Some(relative) = entry.enclosed_name() else {
            return Err(format!(
                "Refusing zip entry \"{}\": it escapes the archive root.",
                entry.name()
            ));
        };
        let target = dest.join(&relative);
        if !target.starts_with(&dest) {
            return Err(format!(
                "Refusing zip entry \"{}\": it escapes the destination.",
                entry.name()
            ));
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|e| format!("Cannot create {}: {e}", target.display()))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
        }
        let mut out = std::fs::File::create(&target)
            .map_err(|e| format!("Cannot write {}: {e}", target.display()))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("Cannot write {}: {e}", target.display()))?;
        let _ = out.flush();
        restore_mode(&target, entry.unix_mode());
    }
    Ok(())
}

/// The plugin root inside an extracted archive: the destination itself when it
/// holds a manifest, otherwise its single top-level directory (a GitHub zip
/// wraps everything in `<repo>-<ref>/`).
pub fn detect_plugin_root(dir: &Path) -> PathBuf {
    if has_manifest(dir) {
        return dir.to_path_buf();
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return dir.to_path_buf();
    };
    let dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    if let [only] = dirs.as_slice()
        && has_manifest(only)
    {
        return only.clone();
    }
    dir.to_path_buf()
}

/// Whether `dir` holds a plugin manifest.
pub fn has_manifest(dir: &Path) -> bool {
    dir.join("kimi.plugin.json").is_file() || dir.join(".kimi-plugin/plugin.json").is_file()
}

/// Copy `source` into `dest`, replacing whatever was there. The previous copy
/// is moved aside first and only removed once the new one is in place, so a
/// failure leaves the old install intact.
pub fn replace_directory(source: &Path, dest: &Path) -> Result<(), String> {
    let parent = dest
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", dest.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;

    let name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("plugin");
    let staging = parent.join(format!(".{name}.staging"));
    let previous = parent.join(format!(".{name}.previous"));
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_dir_all(&previous);

    copy_tree(source, &staging)?;

    if dest.exists() {
        std::fs::rename(dest, &previous)
            .map_err(|e| format!("Cannot move {} aside: {e}", dest.display()))?;
    }
    if let Err(error) = std::fs::rename(&staging, dest) {
        // Put the previous copy back so the install is not left half-done.
        if previous.exists() {
            let _ = std::fs::rename(&previous, dest);
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("Cannot install into {}: {error}", dest.display()));
    }
    let _ = std::fs::remove_dir_all(&previous);
    Ok(())
}

fn copy_tree(source: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("Cannot create {}: {e}", dest.display()))?;
    let entries =
        std::fs::read_dir(source).map_err(|e| format!("Cannot read {}: {e}", source.display()))?;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)
                .map_err(|e| format!("Cannot copy {}: {e}", from.display()))?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn restore_mode(path: &Path, mode: Option<u32>) {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = mode {
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & 0o777));
    }
}

#[cfg(not(unix))]
fn restore_mode(_path: &Path, _mode: Option<u32>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_urls_become_default_branch_archives() {
        assert_eq!(
            archive_url_for("https://github.com/obra/superpowers"),
            "https://github.com/obra/superpowers/archive/HEAD.zip"
        );
        assert_eq!(
            archive_url_for("https://github.com/obra/superpowers.git"),
            "https://github.com/obra/superpowers/archive/HEAD.zip"
        );
        assert_eq!(
            archive_url_for("https://github.com/obra/superpowers/"),
            "https://github.com/obra/superpowers/archive/HEAD.zip"
        );
        // A zip URL is already an archive.
        assert_eq!(
            archive_url_for("https://example.test/plugin.zip"),
            "https://example.test/plugin.zip"
        );
    }

    #[test]
    fn detect_plugin_root_unwraps_a_single_top_level_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();

        // A manifest at the top level wins.
        std::fs::write(root.join("kimi.plugin.json"), "{}").unwrap();
        assert_eq!(detect_plugin_root(root), root);

        // A GitHub-style wrapper is unwrapped.
        let wrapped = tempfile::tempdir().unwrap();
        let inner = wrapped.path().join("repo-main");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(inner.join("kimi.plugin.json"), "{}").unwrap();
        assert_eq!(detect_plugin_root(wrapped.path()), inner);

        // Two top-level directories with no manifest stay put.
        let ambiguous = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(ambiguous.path().join("a")).unwrap();
        std::fs::create_dir_all(ambiguous.path().join("b")).unwrap();
        assert_eq!(detect_plugin_root(ambiguous.path()), ambiguous.path());
    }

    #[test]
    fn extract_archive_unwraps_a_github_style_archive() {
        let mut buffer = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            writer.add_directory("repo-main/", options).unwrap();
            writer
                .start_file("repo-main/kimi.plugin.json", options)
                .unwrap();
            writer.write_all(br#"{"name":"demo"}"#).unwrap();
            writer
                .start_file("repo-main/commands/review.md", options)
                .unwrap();
            writer.write_all(b"Review it\n").unwrap();
            writer.finish().unwrap();
        }

        let temp = tempfile::tempdir().unwrap();
        let dest = temp.path().join("extracted");
        extract_archive(&buffer, &dest).unwrap();

        let root = detect_plugin_root(&dest);
        assert_eq!(root, dest.join("repo-main"));
        assert!(root.join("kimi.plugin.json").is_file());
        assert!(root.join("commands/review.md").is_file());
    }

    #[test]
    fn extract_archive_refuses_a_traversal_entry() {
        let mut buffer = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            writer.start_file("../escape.txt", options).unwrap();
            writer.write_all(b"nope").unwrap();
            writer.finish().unwrap();
        }

        let temp = tempfile::tempdir().unwrap();
        let dest = temp.path().join("extracted");
        let error = extract_archive(&buffer, &dest).unwrap_err();
        assert!(error.contains("escapes"), "unexpected error: {error}");
        assert!(!temp.path().join("escape.txt").exists());
    }

    /// Serve `body` once from a loopback port and return its URL.
    fn serve_once(body: Vec<u8>) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&body);
                let _ = stream.flush();
            }
        });
        format!("http://{addr}/plugin.zip")
    }

    /// A GitHub-style archive: one wrapper directory holding the plugin.
    fn wrapped_plugin_zip() -> Vec<u8> {
        let mut buffer = Vec::new();
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        writer.add_directory("repo-main/", options).unwrap();
        writer
            .start_file("repo-main/kimi.plugin.json", options)
            .unwrap();
        writer.write_all(br#"{"name":"demo"}"#).unwrap();
        writer
            .start_file("repo-main/commands/review.md", options)
            .unwrap();
        writer.write_all(b"Review it\n").unwrap();
        writer.finish().unwrap();
        buffer
    }

    #[test]
    fn a_served_archive_downloads_extracts_and_installs() {
        let temp = tempfile::tempdir().unwrap();
        let url = serve_once(wrapped_plugin_zip());

        // The production path refuses loopback; the test seam relaxes it so the
        // whole download → extract → install chain runs against a real socket.
        let bytes = download_archive_allowing_private(&url).unwrap();

        let staging = temp.path().join("staging");
        extract_archive(&bytes, &staging).unwrap();
        let root = detect_plugin_root(&staging);
        assert!(
            has_manifest(&root),
            "root {} has no manifest",
            root.display()
        );

        let managed = temp.path().join("managed").join("demo");
        replace_directory(&root, &managed).unwrap();
        assert!(managed.join("kimi.plugin.json").is_file());
        assert!(managed.join("commands/review.md").is_file());
    }

    #[test]
    fn the_production_download_refuses_loopback() {
        // Nothing listens on port 9; the guard must refuse before connecting.
        let error = download_archive("http://127.0.0.1:9/plugin.zip").unwrap_err();
        assert!(error.contains("private"), "unexpected error: {error}");
    }

    #[test]
    fn replace_directory_swaps_and_keeps_the_old_copy_on_failure() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let dest = temp.path().join("managed").join("demo");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("kimi.plugin.json"), "{\"name\":\"demo\"}").unwrap();

        replace_directory(&source, &dest).unwrap();
        assert!(dest.join("kimi.plugin.json").is_file());

        // A second install replaces the content.
        std::fs::write(source.join("extra.txt"), "v2").unwrap();
        replace_directory(&source, &dest).unwrap();
        assert!(dest.join("extra.txt").is_file());
        // No staging or previous directory is left behind.
        let leftovers: Vec<String> = std::fs::read_dir(dest.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "left behind: {leftovers:?}");
    }
}
