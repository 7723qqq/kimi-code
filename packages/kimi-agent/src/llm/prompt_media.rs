//! Prompt-intake media preparation — the engine half of v2's
//! `agent/media/promptMedia.ts` + `image-compress.ts`.
//!
//! v2 compressed a prompt's inline images at intake: an image over the
//! model's pixel or byte budget was resized/re-encoded, the original was
//! persisted, and a caption naming both was inserted before the image part.
//! The fork's TUI path does this host-side (`apps/kimi-code`'s
//! `image-placeholder.ts` over the napi `native_compress_image`), but the
//! HTTP prompt path — the web UI's submissions — passed inline base64
//! images straight through with no compression and no caption (ROADMAP
//! #3747b). This module is that path's half.
//!
//! Two v2 intake behaviors are deliberately not ported, because the fork's
//! #3784 rebuild moved them to request time: the model-accepted-mime gate
//! (the resolver emits a `<image path="…">` tag when the model cannot take
//! the family) and the request media budget (`media_budget.rs`). What is
//! ported here is the part with no request-time equivalent: the compression
//! itself and its caption.
//!
//! The caption wording is the fork's own, byte-for-byte the one
//! `packages/node-sdk/src/media/image-compress.ts` emits (itself a port of
//! v2's with the fork's two substitutions: `Read` instead of the
//! nonexistent `ReadMediaFile` tool, and the `, `-joined variant
//! description). One caption text must read the same whichever surface
//! compressed the image.

use std::path::PathBuf;

use base64::Engine as _;
use sha2::{Digest, Sha256};

use crate::native::image_compress::{CompressConfig, compress_image};
use crate::rpc::types::ContentBlock;
use crate::server::files::FileStore;

/// v2 `MAX_IMAGE_EDGE_PX` — the longest-edge budget for a prompt image.
pub const MAX_IMAGE_EDGE_PX: u32 = 2000;

/// v2 `DEFAULT_INLINE_IMAGE_BYTE_BUDGET` (3.75 MiB) — the per-image byte
/// budget for a prompt image.
pub const INLINE_IMAGE_BYTE_BUDGET: usize = 3_932_160;

/// v2 `MAX_IMAGE_DECODE_BYTES` — over this, the image is passed through
/// untouched rather than decoded (the decode-bomb guard the TS wrapper
/// owns; `compress_image` itself only computes).
pub const MAX_IMAGE_DECODE_BYTES: usize = 64 * 1024 * 1024;

const FALLBACK_EDGES_PX: [u32; 6] = [2000, 1000, 768, 512, 384, 256];
const JPEG_QUALITY_STEPS: [u8; 4] = [80, 60, 40, 20];

/// The engine-side compression budget for a prompt's inline image — v2's
/// `compressImageForModel` defaults.
pub fn prompt_compress_config() -> CompressConfig {
    CompressConfig {
        max_edge: MAX_IMAGE_EDGE_PX,
        byte_budget: INLINE_IMAGE_BYTE_BUDGET,
        fallback_edges: FALLBACK_EDGES_PX.to_vec(),
        jpeg_quality_steps: JPEG_QUALITY_STEPS.to_vec(),
    }
}

/// One side of a caption's comparison (v2 `ImageVariantDescription`).
pub struct ImageVariant {
    pub width: u32,
    pub height: u32,
    pub byte_length: usize,
    pub mime_type: String,
}

/// v2 `formatByteSize`, as the fork's SDK port words it.
pub fn format_byte_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{} KB", (bytes as f64 / 1024.0).round())
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

fn describe_image_variant(variant: &ImageVariant) -> String {
    let mut parts = Vec::new();
    if variant.width > 0 && variant.height > 0 {
        parts.push(format!("{}x{}", variant.width, variant.height));
    }
    if variant.byte_length > 0 {
        parts.push(format_byte_size(variant.byte_length));
    }
    if !variant.mime_type.is_empty() {
        parts.push(
            variant
                .mime_type
                .trim_start_matches("image/")
                .to_uppercase(),
        );
    }
    parts.join(", ")
}

/// The compression caption, byte-for-byte the SDK's
/// `buildImageCompressionCaption` (v2's text with the fork's `Read`
/// substitution — the fork has no `ReadMediaFile` tool; media reads go
/// through `Read` itself).
pub fn build_image_compression_caption(
    original: &ImageVariant,
    final_variant: &ImageVariant,
    original_path: Option<&str>,
) -> String {
    let mut sentences = vec![format!(
        "Image compressed to fit model limits: original {} -> sent {}.",
        describe_image_variant(original),
        describe_image_variant(final_variant),
    )];
    sentences.push("Fine detail may be lost.".to_string());
    match original_path {
        Some(path) if !path.is_empty() => sentences.push(format!(
            "The uncompressed original is saved at \"{path}\"; if you need fine detail (e.g. small text), call Read on that path with the region parameter (original-pixel coordinates) to view a crop at full fidelity."
        )),
        _ => sentences.push("The uncompressed original was not preserved.".to_string()),
    }
    format!("<system>{}</system>", sentences.join(" "))
}

/// Persist an uncompressed original under the file store, content-addressed
/// so the same original submitted twice occupies one blob (v2's
/// `persistOriginalImage` wrote a sha256-named cache file; the store's
/// `save_with_id` is the fork's dedupe seam, and its blob path is what the
/// caption names — `Read` serves paths outside the workspace). `None` when
/// the store cannot take it, which the caption reports as "not preserved".
pub fn persist_original_image(
    store: &FileStore,
    bytes: &[u8],
    mime_type: &str,
    name: &str,
) -> Option<PathBuf> {
    if bytes.is_empty() {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let id = format!("f_orig_{:x}", hasher.finalize());
    store
        .save_with_id(&id, name, mime_type, None, bytes)
        .ok()
        .and_then(|_| store.blob_path(&id))
}

/// Prepare one inline base64 image part for the model (v2's
/// `compressBase64ForModel` + caption half of `resolvePromptMediaFiles`).
///
/// Returns the caption to insert before the image (when compression
/// changed the bytes) and the block to send. A decode failure, an
/// over-`MAX_IMAGE_DECODE_BYTES` payload, or an image already within both
/// budgets passes through unchanged with no caption — v2's `passthrough`.
pub fn prepare_inline_image(
    store: &FileStore,
    media_type: &str,
    data_base64: &str,
    name: Option<&str>,
) -> (Option<String>, ContentBlock) {
    let passthrough = || ContentBlock::Image {
        media_type: media_type.to_string(),
        data: data_base64.to_string(),
        name: name.map(str::to_string),
    };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data_base64) else {
        return (None, passthrough());
    };
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_DECODE_BYTES {
        return (None, passthrough());
    }
    let Some(result) = compress_image(&bytes, media_type, &prompt_compress_config()) else {
        return (None, passthrough());
    };
    if !result.changed {
        return (None, passthrough());
    }
    let original_path = persist_original_image(store, &bytes, media_type, name.unwrap_or("image"))
        .map(|path| path.display().to_string());
    let caption = build_image_compression_caption(
        &ImageVariant {
            width: result.original_width,
            height: result.original_height,
            byte_length: result.original_byte_length,
            mime_type: media_type.to_string(),
        },
        &ImageVariant {
            width: result.width,
            height: result.height,
            byte_length: result.final_byte_length,
            mime_type: result.mime_type.clone(),
        },
        original_path.as_deref(),
    );
    let block = ContentBlock::Image {
        media_type: result.mime_type,
        data: base64::engine::general_purpose::STANDARD.encode(&result.data),
        name: name.map(str::to_string),
    };
    (Some(caption), block)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, Rgb, RgbImage};

    fn rgb_image(width: u32, height: u32) -> DynamicImage {
        let mut img = RgbImage::new(width, height);
        for (x, y, pixel) in img.enumerate_pixels_mut() {
            *pixel = Rgb([(x % 251) as u8, (y % 241) as u8, ((x + y) % 239) as u8]);
        }
        DynamicImage::ImageRgb8(img)
    }

    fn png_base64(width: u32, height: u32) -> String {
        let mut bytes = Vec::new();
        rgb_image(width, height)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    }

    fn store_in(dir: &tempfile::TempDir) -> FileStore {
        FileStore::with_root(dir.path().to_path_buf())
    }

    #[test]
    fn format_byte_size_matches_the_sdk_wording() {
        assert_eq!(format_byte_size(512), "512 B");
        assert_eq!(format_byte_size(2048), "2 KB");
        assert_eq!(format_byte_size(5_242_880), "5.0 MB");
    }

    #[test]
    fn the_caption_is_the_sdks_caption_verbatim() {
        let caption = build_image_compression_caption(
            &ImageVariant {
                width: 4000,
                height: 3000,
                byte_length: 5_242_880,
                mime_type: "image/png".into(),
            },
            &ImageVariant {
                width: 2000,
                height: 1500,
                byte_length: 1_048_576,
                mime_type: "image/jpeg".into(),
            },
            Some("/cache/kimi-code-original-images/abc.png"),
        );
        assert_eq!(
            caption,
            "<system>Image compressed to fit model limits: original 4000x3000, 5.0 MB, PNG -> sent 2000x1500, 1.0 MB, JPEG. Fine detail may be lost. The uncompressed original is saved at \"/cache/kimi-code-original-images/abc.png\"; if you need fine detail (e.g. small text), call Read on that path with the region parameter (original-pixel coordinates) to view a crop at full fidelity.</system>"
        );
    }

    #[test]
    fn a_caption_without_a_preserved_original_says_so() {
        let caption = build_image_compression_caption(
            &ImageVariant {
                width: 10,
                height: 10,
                byte_length: 100,
                mime_type: "image/png".into(),
            },
            &ImageVariant {
                width: 10,
                height: 10,
                byte_length: 90,
                mime_type: "image/jpeg".into(),
            },
            None,
        );
        assert!(caption.ends_with(
            "Fine detail may be lost. The uncompressed original was not preserved.</system>"
        ));
    }

    #[test]
    fn an_over_budget_inline_image_is_compressed_captioned_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let data = png_base64(4000, 3000);

        let (caption, block) = prepare_inline_image(&store, "image/png", &data, Some("shot.png"));

        let caption = caption.expect("an over-budget image is captioned");
        assert!(
            caption
                .starts_with("<system>Image compressed to fit model limits: original 4000x3000,")
        );
        assert!(caption.contains("Fine detail may be lost."));
        assert!(caption.contains("call Read on that path"));
        // The caption names a real persisted original.
        let path = caption
            .split("saved at \"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .expect("the caption names the original's path");
        assert!(std::path::Path::new(path).exists(), "{path}");

        let ContentBlock::Image {
            media_type,
            data: sent,
            name,
        } = block
        else {
            panic!("expected an image block");
        };
        assert_eq!(name.as_deref(), Some("shot.png"));
        assert!(media_type.starts_with("image/"));
        let sent_bytes = base64::engine::general_purpose::STANDARD
            .decode(&sent)
            .expect("the sent block is valid base64");
        assert!(!sent_bytes.is_empty());
    }

    #[test]
    fn a_small_inline_image_passes_through_uncaptioned() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let data = png_base64(10, 10);

        let (caption, block) = prepare_inline_image(&store, "image/png", &data, None);

        assert!(caption.is_none(), "an in-budget image is not captioned");
        let ContentBlock::Image {
            media_type,
            data: sent,
            ..
        } = block
        else {
            panic!("expected an image block");
        };
        assert_eq!(media_type, "image/png");
        assert_eq!(sent, data, "the original bytes pass through untouched");
    }

    #[test]
    fn undecodable_bytes_pass_through_uncaptioned() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let data = base64::engine::general_purpose::STANDARD.encode(b"not an image");

        let (caption, block) = prepare_inline_image(&store, "image/png", &data, None);

        assert!(caption.is_none());
        let ContentBlock::Image { data: sent, .. } = block else {
            panic!("expected an image block");
        };
        assert_eq!(sent, data);
    }
}
