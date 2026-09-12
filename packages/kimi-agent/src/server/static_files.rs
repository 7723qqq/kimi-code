//! Static file serving and Single Page Application (SPA) routing fallback.

use crate::server::router::HttpResponse;
use std::path::{Component, Path};

/// Resolve appropriate MIME content-type based on file extension.
pub fn mime_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("") {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "map" => "application/json",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Serve a static file from `assets_dir` with SPA routing fallback.
///
/// Security:
/// - Rejects path traversal (any `..` or root components).
///
/// SPA routing behavior:
/// - If `req_path` is empty or "/", serves `index.html`.
/// - If target file exists and is a regular file, serves it with its MIME type.
/// - If target file does NOT exist and `req_path` does not start with "/api",
///   falls back to serving `index.html` (for client-side routing).
/// - If `index.html` also does not exist or cannot be read, returns 404.
pub fn serve_static_file(assets_dir: &Path, req_path: &str) -> HttpResponse {
    let clean_path = req_path.trim_start_matches('/');

    // Check path components for traversal attacks
    let path_obj = Path::new(clean_path);
    for component in path_obj.components() {
        match component {
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return HttpResponse::not_found();
            }
            Component::Normal(_) | Component::CurDir => {}
        }
    }

    let target_file = if clean_path.is_empty() {
        assets_dir.join("index.html")
    } else {
        assets_dir.join(path_obj)
    };

    if target_file.is_file()
        && let Ok(bytes) = std::fs::read(&target_file)
    {
        let mime = mime_for_path(&target_file);
        return HttpResponse::bytes(200, mime, bytes);
    }

    // SPA fallback: serve index.html for non-API routes
    if !req_path.starts_with("/api") {
        let index_file = assets_dir.join("index.html");
        if index_file.is_file()
            && let Ok(bytes) = std::fs::read(&index_file)
        {
            return HttpResponse::bytes(200, "text/html; charset=utf-8", bytes);
        }
    }

    HttpResponse::not_found()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn test_mime_for_path() {
        assert_eq!(
            mime_for_path(Path::new("index.html")),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            mime_for_path(Path::new("about.htm")),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            mime_for_path(Path::new("app.js")),
            "application/javascript; charset=utf-8"
        );
        assert_eq!(
            mime_for_path(Path::new("bundle.mjs")),
            "application/javascript; charset=utf-8"
        );
        assert_eq!(
            mime_for_path(Path::new("style.css")),
            "text/css; charset=utf-8"
        );
        assert_eq!(mime_for_path(Path::new("data.json")), "application/json");
        assert_eq!(mime_for_path(Path::new("app.js.map")), "application/json");
        assert_eq!(mime_for_path(Path::new("logo.svg")), "image/svg+xml");
        assert_eq!(mime_for_path(Path::new("image.png")), "image/png");
        assert_eq!(mime_for_path(Path::new("photo.jpg")), "image/jpeg");
        assert_eq!(mime_for_path(Path::new("photo.jpeg")), "image/jpeg");
        assert_eq!(mime_for_path(Path::new("anim.gif")), "image/gif");
        assert_eq!(mime_for_path(Path::new("icon.ico")), "image/x-icon");
        assert_eq!(mime_for_path(Path::new("photo.webp")), "image/webp");
        assert_eq!(mime_for_path(Path::new("module.wasm")), "application/wasm");
        assert_eq!(mime_for_path(Path::new("font.woff")), "font/woff");
        assert_eq!(mime_for_path(Path::new("font.woff2")), "font/woff2");
        assert_eq!(mime_for_path(Path::new("font.ttf")), "font/ttf");
        assert_eq!(
            mime_for_path(Path::new("license.txt")),
            "text/plain; charset=utf-8"
        );
        assert_eq!(
            mime_for_path(Path::new("data.bin")),
            "application/octet-stream"
        );
        assert_eq!(
            mime_for_path(Path::new("no_extension")),
            "application/octet-stream"
        );
    }

    #[test]
    fn test_serve_static_file_regular_and_spa_fallback() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("index.html");
        let mut f1 = File::create(&index_path).unwrap();
        f1.write_all(b"<html><body>Kimi Web</body></html>").unwrap();

        let js_dir = dir.path().join("assets");
        fs::create_dir(&js_dir).unwrap();
        let js_path = js_dir.join("main.js");
        let mut f2 = File::create(&js_path).unwrap();
        f2.write_all(b"console.log('hello');").unwrap();

        // 1. Root and empty path serve index.html
        let res_root = serve_static_file(dir.path(), "/");
        assert_eq!(res_root.status, 200);
        assert_eq!(
            res_root.header("content-type"),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(res_root.body, b"<html><body>Kimi Web</body></html>");

        let res_empty = serve_static_file(dir.path(), "");
        assert_eq!(res_empty.status, 200);
        assert_eq!(res_empty.body, b"<html><body>Kimi Web</body></html>");

        // 2. Specific existing asset
        let res_js = serve_static_file(dir.path(), "/assets/main.js");
        assert_eq!(res_js.status, 200);
        assert_eq!(
            res_js.header("content-type"),
            Some("application/javascript; charset=utf-8")
        );
        assert_eq!(res_js.body, b"console.log('hello');");

        // 3. SPA deep route fallback (e.g. /session/sess-123)
        let res_spa = serve_static_file(dir.path(), "/session/sess-123");
        assert_eq!(res_spa.status, 200);
        assert_eq!(
            res_spa.header("content-type"),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(res_spa.body, b"<html><body>Kimi Web</body></html>");

        // 4. Traversal attack variations return 404
        assert_eq!(serve_static_file(dir.path(), "/../secret.txt").status, 404);
        assert_eq!(
            serve_static_file(dir.path(), "/assets/../../secret.txt").status,
            404
        );
        assert_eq!(serve_static_file(dir.path(), "/..").status, 404);

        // 5. Missing asset under /api does NOT fallback to index.html
        let res_api = serve_static_file(dir.path(), "/api/v1/missing");
        assert_eq!(res_api.status, 404);

        // 6. Directory without index.html falls back or returns 404
        let empty_dir = tempdir().unwrap();
        let res_missing_index = serve_static_file(empty_dir.path(), "/");
        assert_eq!(res_missing_index.status, 404);
        let res_missing_spa = serve_static_file(empty_dir.path(), "/some/route");
        assert_eq!(res_missing_spa.status, 404);
    }
}
