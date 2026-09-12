//! Session canonical media and attachment retrieval.
//!
//! Mirrors kap-server's `/api/v1/sessions/:id/media/:file_id` REST endpoint.

use std::path::{Path, PathBuf};

/// Determine the Content-Type header from file extension.
pub fn mime_for_path(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Locate a session media file by session ID and file ID.
pub fn locate_session_media(session_id: &str, file_id: &str) -> Option<PathBuf> {
    // 1. Check user profile / home session media directory
    let home_path = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    let base = PathBuf::from(home_path).join(".kimi-code");

    let candidates = [
        base.join("sessions")
            .join(session_id)
            .join("media")
            .join(file_id),
        base.join("media").join(file_id),
        PathBuf::from(file_id),
    ];

    candidates.into_iter().find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mime_for_path() {
        // Standard images
        assert_eq!(mime_for_path(Path::new("pic.png")), "image/png");
        assert_eq!(mime_for_path(Path::new("photo.jpg")), "image/jpeg");
        assert_eq!(mime_for_path(Path::new("photo.jpeg")), "image/jpeg");
        assert_eq!(mime_for_path(Path::new("anim.gif")), "image/gif");
        assert_eq!(mime_for_path(Path::new("graphic.webp")), "image/webp");
        assert_eq!(mime_for_path(Path::new("vector.svg")), "image/svg+xml");

        // Documents and text
        assert_eq!(mime_for_path(Path::new("doc.pdf")), "application/pdf");
        assert_eq!(mime_for_path(Path::new("payload.json")), "application/json");
        assert_eq!(
            mime_for_path(Path::new("notes.txt")),
            "text/plain; charset=utf-8"
        );

        // Case-insensitivity
        assert_eq!(mime_for_path(Path::new("IMAGE.PNG")), "image/png");
        assert_eq!(mime_for_path(Path::new("Photo.JPEG")), "image/jpeg");
        assert_eq!(mime_for_path(Path::new("DATA.JSON")), "application/json");

        // Edge cases: dots, dotfiles, no extension, unknown extension
        assert_eq!(
            mime_for_path(Path::new("complex.name.with.dots.png")),
            "image/png"
        );
        assert_eq!(
            mime_for_path(Path::new(".gitignore")),
            "application/octet-stream"
        );
        assert_eq!(
            mime_for_path(Path::new("LICENSE")),
            "application/octet-stream"
        );
        assert_eq!(
            mime_for_path(Path::new("unknown.bin")),
            "application/octet-stream"
        );
        assert_eq!(
            mime_for_path(Path::new("something.xyz123")),
            "application/octet-stream"
        );
    }

    #[test]
    fn test_locate_session_media() {
        // 1. Missing file returns None
        assert!(locate_session_media("sess-missing", "non-existent-media-file-xyz.png").is_none());

        // 2. Real file located directly via file_id as existing file path
        let temp_dir = tempfile::tempdir().unwrap();
        let sample_file = temp_dir.path().join("sample_media.png");
        std::fs::write(&sample_file, b"sample bytes").unwrap();

        let found = locate_session_media("sess-any", sample_file.to_str().unwrap());
        assert_eq!(found, Some(sample_file));
    }
}
