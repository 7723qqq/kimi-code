//! Read-on-image: the model asking to look at an image file.
//!
//! Ported from v2's `execute-media-read.ts`: sniff the file, gate on the
//! model's image capability and the size limits, then hand the image to the
//! conversation through a [`ToolDelivery`] — a follow-up user message, the
//! only shape OpenAI-compatible APIs accept for tool-produced media.
//!
//! Three delivery shapes, exactly as v2:
//! - default: compress to fit `[image].read_byte_budget` / `max_edge_px`;
//! - `region`: crop the requested rectangle out of the original image;
//! - `full_resolution`: send the original bytes untouched (region, when
//!   present, keeps the crop at native resolution instead).

use std::path::Path;

use base64::prelude::*;
use serde_json::Value;

use crate::native::file_type::{
    FileKind, MEDIA_SNIFF_BYTES, detect_file_type, resolve_mime, sniff_image_dimensions,
};
use crate::native::image_compress::{self, CompressConfig, CropConfig};
use crate::rpc::types::ContentBlock;
use crate::turn_loop::types::{ExecutableToolResult, ToolDelivery};

/// v2 `READ_IMAGE_BYTE_BUDGET`: default raw-byte budget for model-initiated
/// image reads.
pub const READ_IMAGE_BYTE_BUDGET: u64 = 256 * 1024;
/// v2 `MAX_IMAGE_EDGE_PX`: default longest-edge ceiling.
pub const MAX_IMAGE_EDGE_PX: u32 = 2000;
/// v2 `MAX_MEDIA_BYTES` (100 MB): absolute media-file ceiling.
const MAX_MEDIA_BYTES: u64 = 100 * 1024 * 1024;
/// v2 `MAX_IMAGE_DECODE_BYTES`: decoding past this is refused when the file
/// also exceeds the delivery budget.
const MAX_IMAGE_DECODE_BYTES: u64 = 64 * 1024 * 1024;
/// v2 `FALLBACK_EDGES_PX`.
const FALLBACK_EDGES_PX: [u32; 6] = [2000, 1000, 768, 512, 384, 256];
/// v2 `JPEG_QUALITY_STEPS`.
const JPEG_QUALITY_STEPS: [u8; 4] = [80, 60, 40, 20];
/// v2 `MODEL_ACCEPTED_IMAGE_MIMES`.
const MODEL_ACCEPTED_IMAGE_MIMES: [&str; 4] =
    ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Upstream #3649: Kimi models accept BMP, HEIC, and HEIF in addition to baseline formats.
pub const KIMI_ACCEPTED_IMAGE_MIMES: [&str; 7] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/heic",
    "image/heif",
];

/// Upstream #3649: Default raw-byte inline budget (3.75 MB).
pub const DEFAULT_INLINE_IMAGE_BYTE_BUDGET: u64 = 3_932_160;

/// Upstream #3649: Kimi model inline image budget (5 MB).
pub const KIMI_INLINE_IMAGE_BYTE_BUDGET: u64 = 5 * 1024 * 1024;

/// Check if an image MIME type is accepted by the given provider (defaulting to baseline set).
pub fn is_model_accepted_image_mime(mime: &str, provider: Option<&str>) -> bool {
    if provider == Some("kimi") {
        KIMI_ACCEPTED_IMAGE_MIMES.contains(&mime)
    } else {
        MODEL_ACCEPTED_IMAGE_MIMES.contains(&mime)
    }
}

/// Upstream #3649 inline image byte budget for the provider.
pub fn inline_image_byte_budget(provider: Option<&str>) -> u64 {
    if provider == Some("kimi") {
        KIMI_INLINE_IMAGE_BYTE_BUDGET
    } else {
        DEFAULT_INLINE_IMAGE_BYTE_BUDGET
    }
}

/// A crop rectangle, in original-image pixel coordinates (v2 `MediaReadRegion`).
#[derive(Debug, Clone, Copy)]
pub struct ImageRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The media arguments of one Read call (v2 `MediaReadArgs`).
#[derive(Debug, Clone, Copy, Default)]
pub struct ReadMediaRequest {
    /// `region`: view just this rectangle, at full fidelity when it fits.
    pub region: Option<ImageRegion>,
    /// `full_resolution`: skip the default downscaling.
    pub full_resolution: bool,
}

impl ReadMediaRequest {
    /// Whether the call explicitly asks for a non-default image rendering.
    /// Both shapes need a full decode, so they share v2's decode-limit gate.
    fn is_explicit(&self) -> bool {
        self.region.is_some() || self.full_resolution
    }

    /// Parse the media arguments of one Read call. v2 rejects a malformed
    /// `region` / `full_resolution` at the zod schema boundary; the engine has
    /// to render that refusal itself, so a malformed value is `Err` rather
    /// than silently ignored.
    pub fn from_args(args: &Value) -> Result<Self, String> {
        let region = match args.get("region") {
            None | Some(Value::Null) => None,
            Some(value) => {
                let number = |key: &str| value.get(key).and_then(|v| v.as_f64());
                let (Some(x), Some(y), Some(width), Some(height)) =
                    (number("x"), number("y"), number("width"), number("height"))
                else {
                    return Err(
                        "Invalid Read arguments: `region` needs numeric x, y, width and height."
                            .to_string(),
                    );
                };
                if width < 1.0 || height < 1.0 {
                    return Err(
                        "Invalid Read arguments: `region.width` and `region.height` must be positive."
                            .to_string(),
                    );
                }
                Some(ImageRegion {
                    x,
                    y,
                    width,
                    height,
                })
            }
        };
        let full_resolution = match args.get("full_resolution") {
            None | Some(Value::Null) => false,
            Some(value) => value.as_bool().ok_or_else(|| {
                "Invalid Read arguments: `full_resolution` must be a boolean.".to_string()
            })?,
        };
        Ok(Self {
            region,
            full_resolution,
        })
    }
}

/// The limits one media read applies. Every `None` falls back to the v2
/// default, so an unconfigured session behaves exactly like v2.
#[derive(Debug, Clone, Default)]
pub struct ReadMediaLimits {
    pub read_byte_budget: Option<u64>,
    pub max_edge_px: Option<u32>,
    /// Session model image capability. `Some(false)` means the session
    /// declared capabilities but not image input — the read is refused;
    /// `None` (unknown model) and `Some(true)` both allow it (v2's
    /// unknown-capability leniency).
    pub image_in: Option<bool>,
    /// Provider type (e.g. "kimi").
    pub provider: Option<String>,
}

impl ReadMediaLimits {
    fn budget(&self) -> u64 {
        self.read_byte_budget
            .filter(|value| *value > 0)
            .unwrap_or(READ_IMAGE_BYTE_BUDGET)
    }

    fn max_edge(&self) -> u32 {
        self.max_edge_px
            .filter(|value| *value > 0)
            .unwrap_or(MAX_IMAGE_EDGE_PX)
    }
}

/// Which rendering was actually attached, so the note can describe it
/// (v2 `ImageDelivery`).
enum ImageDelivery {
    /// The original bytes were already within budget.
    Untouched,
    /// The default path re-encoded the image smaller.
    Downsampled {
        width: u32,
        height: u32,
        mime: String,
        bytes: usize,
    },
    /// `region` was honored; `region` is the clamped rectangle in original
    /// image coordinates.
    Crop {
        region: (u32, u32, u32, u32),
        width: u32,
        height: u32,
        resized: bool,
    },
    /// `full_resolution` sent the original bytes as-is.
    Full,
}

/// What one branch decided to attach: the encoded bytes plus the dimensions
/// the default path's post-check needs (`compressed.width` / `.height`).
struct Delivered {
    data: Vec<u8>,
    mime: String,
    width: u32,
    height: u32,
    delivery: ImageDelivery,
}

fn err_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult {
        stop_turn: false,
        content,
        is_error: true,
        note: None,
        delivery: None,
    }
}

fn format_byte_size(bytes: usize) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.0}KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} bytes")
    }
}

fn delivery_limit_error(final_bytes: u64, read_byte_budget: u64, max_edge: u32) -> String {
    format!(
        "Image is too large to send safely after compression ({final_bytes} bytes; limit {read_byte_budget} bytes and {max_edge}px on the longest edge). The original image was not sent to the model. Do not retry the same file unchanged. Use Bash or an available image-processing tool to create a smaller copy within both limits, then call Read on the smaller copy."
    )
}

/// v2 `buildImageDecodeLimitError`: `region` and `full_resolution` both need
/// a full decode, which is refused past the safe decode ceiling.
fn decode_limit_error(final_bytes: u64) -> String {
    format!(
        "Image is too large to process safely for region or full_resolution ({final_bytes} bytes; safe decode limit {MAX_IMAGE_DECODE_BYTES} bytes). The original image was not sent to the model. Do not retry the same file unchanged. Use Bash or an available image-processing tool to create a smaller copy or crop the needed region into a separate image, then call Read on the resulting file."
    )
}

/// v2 `buildFullResolutionLimitError`: `full_resolution` must fit the provider's
/// inline image byte budget.
fn full_resolution_limit_error(path: &Path, final_bytes: u64, inline_budget: u64) -> String {
    format!(
        "\"{}\" is {final_bytes} bytes ({}), over the {inline_budget}-byte ({}) per-image limit, so full_resolution cannot be honored. Use region to view a crop at full fidelity instead.",
        path.display(),
        format_byte_size(final_bytes as usize),
        format_byte_size(inline_budget as usize),
    )
}

/// The v2 `buildMediaNote` summary.
fn build_media_note(
    mime_type: &str,
    byte_size: u64,
    dimensions: Option<(u32, u32)>,
    delivery: &ImageDelivery,
) -> String {
    let mut parts: Vec<String> = vec![
        "Read image file.".to_string(),
        format!("Mime type: {mime_type}."),
        format!("Size: {byte_size} bytes."),
    ];
    if let Some((width, height)) = dimensions {
        parts.push(format!("Original dimensions: {width}x{height} pixels."));
    }
    match delivery {
        ImageDelivery::Downsampled {
            width,
            height,
            mime,
            bytes,
        } => {
            parts.push(format!(
                "The attached image was downsampled to {width}x{height} pixels ({mime}, {}) to fit model limits; fine detail may be lost.",
                format_byte_size(*bytes)
            ));
            parts.push(
                "To inspect fine detail, call Read again with the region parameter (original-image pixel coordinates) to view a crop at full fidelity."
                    .to_string(),
            );
        }
        ImageDelivery::Crop {
            region,
            width,
            height,
            resized,
            ..
        } => {
            let (x, y, region_width, region_height) = *region;
            let scale = if *resized {
                format!(", downsampled to {width}x{height} pixels")
            } else {
                " at native resolution".to_string()
            };
            parts.push(format!(
                "Showing region (x={x}, y={y}, width={region_width}, height={region_height}) of the original image{scale}."
            ));
            parts.push(format!(
                "To output coordinates in original-image pixels, locate them within this crop and add the region offset (x={x}, y={y})."
            ));
        }
        ImageDelivery::Full => {
            parts.push("Shown at native resolution; no downscaling applied.".to_string());
        }
        ImageDelivery::Untouched => {}
    }
    // The relative-coordinates hint is for a full view; the crop branch
    // already carries its own offset instruction.
    if dimensions.is_some() && !matches!(delivery, ImageDelivery::Crop { .. }) {
        parts.push(
            "If you need to output coordinates, output relative coordinates first and compute absolute coordinates using the original image size."
                .to_string(),
        );
    }
    parts.push(
        "If you generate or edit images or videos via commands or scripts, read the result back immediately before continuing."
            .to_string(),
    );
    format!("<system>{}</system>", parts.join(" "))
}

fn read_header(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buffer = vec![0u8; MEDIA_SNIFF_BYTES];
    let read = file.read(&mut buffer).ok()?;
    buffer.truncate(read);
    Some(buffer)
}

/// Read `path` for the model when it is an image. `None` means "not a media
/// file this call handles": text files and unknown binaries *without*
/// `region` / `full_resolution` fall through to the native text read (and,
/// when that declines, to the host).
pub fn read_image_media(
    path: &Path,
    request: &ReadMediaRequest,
    limits: &ReadMediaLimits,
) -> Option<ExecutableToolResult> {
    let header = read_header(path)?;
    match detect_file_type(path, &header) {
        FileKind::Text => {
            // v2 routes text files away from the media path explicitly: the
            // crop / full-resolution args are meaningless for text.
            if request.is_explicit() {
                return Some(err_result(format!(
                    "\"{}\" is a text file. Use Read without region or full_resolution to read text files.",
                    path.display()
                )));
            }
            return None;
        }
        FileKind::Unknown => {
            if request.is_explicit() {
                return Some(err_result(format!(
                    "\"{}\" is not a supported image or video file. Use Read for text files, or Bash or an MCP tool for other binary formats.",
                    path.display()
                )));
            }
            return None;
        }
        FileKind::Video => {
            return Some(err_result(format!(
                "\"{}\" is a video file. Video reads are not supported yet — tell the user.",
                path.display()
            )));
        }
        FileKind::Image => {}
    }

    if limits.image_in == Some(false) {
        return Some(err_result(
            "The current model does not support image input. Tell the user to use a model with image input capability."
                .to_string(),
        ));
    }

    let byte_size = std::fs::metadata(path).ok()?.len();
    if byte_size == 0 {
        return Some(err_result(format!("\"{}\" is empty.", path.display())));
    }
    if byte_size > MAX_MEDIA_BYTES {
        return Some(err_result(format!(
            "\"{}\" is {byte_size} bytes, which exceeds the maximum {}MB for media files.",
            path.display(),
            MAX_MEDIA_BYTES / 1024 / 1024
        )));
    }

    let mime = resolve_mime(path, &header);
    if !is_model_accepted_image_mime(&mime, limits.provider.as_deref()) {
        return Some(err_result(format!(
            "\"{}\" is an {mime} image, which the provider does not accept. Convert it to JPEG first, then read the converted file.",
            path.display()
        )));
    }

    let budget = limits.budget();
    let max_edge = limits.max_edge();
    let inline_budget = inline_image_byte_budget(limits.provider.as_deref());

    // `region` / `full_resolution` force a full decode, so they are refused
    // past the safe decode ceiling regardless of the delivery budget.
    if request.is_explicit() && byte_size > MAX_IMAGE_DECODE_BYTES {
        return Some(err_result(decode_limit_error(byte_size)));
    }
    // `full_resolution` means "send the bytes untouched", so it must fit the
    // fixed per-image limit — `[image].read_byte_budget` cannot enlarge it.
    if request.region.is_none() && request.full_resolution && byte_size > inline_budget {
        return Some(err_result(full_resolution_limit_error(path, byte_size, inline_budget)));
    }
    // Default path: no point decoding something we could never deliver.
    if !request.is_explicit() && byte_size > MAX_IMAGE_DECODE_BYTES && byte_size > budget {
        return Some(err_result(delivery_limit_error(
            byte_size, budget, max_edge,
        )));
    }

    // HEIC/HEIF cannot be re-encoded locally; upstream #3649 sends them inline up to the inline budget.
    if mime == "image/heic" || mime == "image/heif" {
        if request.region.is_some() {
            return Some(err_result(format!(
                "Cropping region is not supported for {mime} images. Convert to PNG or JPEG first."
            )));
        }
        let inline_limit = std::cmp::max(budget, inline_budget);
        if byte_size > inline_limit {
            return Some(err_result(format!(
                "\"{}\" is an {byte_size}-byte {mime} image, which exceeds the {inline_limit}-byte limit. Convert it to JPEG or PNG first, then read the converted file.",
                path.display()
            )));
        }
        let data = std::fs::read(path).ok()?;
        let (width, height) = sniff_image_dimensions(&data).map(|d| (d.width, d.height)).unwrap_or((0, 0));
        let delivery = if request.full_resolution {
            ImageDelivery::Full
        } else {
            ImageDelivery::Untouched
        };
        let note = build_media_note(&mime, byte_size, Some((width, height)), &delivery);
        let base64 = BASE64_STANDARD.encode(&data);
        return Some(ExecutableToolResult {
            stop_turn: false,
            content: format!("<image path=\"{}\" mime=\"{mime}\" size=\"{byte_size}\" />", path.display()),
            is_error: false,
            note: Some(note),
            delivery: Some(ToolDelivery {
                blocks: vec![ContentBlock::Image {
                    media_type: mime,
                    data: base64,
                    name: None,
                }],
            }),
        });
    }

    let data = std::fs::read(path).ok()?;
    let original = sniff_image_dimensions(&data);

    let delivered = if let Some(region) = request.region {
        let outcome = image_compress::crop_image(
            &data,
            &mime,
            region.x,
            region.y,
            region.width,
            region.height,
            &CropConfig {
                max_edge,
                byte_budget: budget as usize,
                skip_resize: request.full_resolution,
                fallback_edges: FALLBACK_EDGES_PX.to_vec(),
                jpeg_quality_steps: JPEG_QUALITY_STEPS.to_vec(),
            },
        );
        let result = match outcome {
            Ok(result) => result,
            Err(error) => {
                return Some(err_result(format!(
                    "Cannot read region from \"{}\": {}",
                    path.display(),
                    error.error_message()
                )));
            }
        };
        Delivered {
            delivery: ImageDelivery::Crop {
                region: (
                    result.region_x,
                    result.region_y,
                    result.region_width,
                    result.region_height,
                ),
                width: result.width,
                height: result.height,
                resized: result.resized,
            },
            data: result.data,
            mime: result.mime_type,
            width: result.width,
            height: result.height,
        }
    } else if request.full_resolution {
        let (width, height) = original.map(|d| (d.width, d.height)).unwrap_or((0, 0));
        Delivered {
            data,
            mime: mime.clone(),
            width,
            height,
            delivery: ImageDelivery::Full,
        }
    } else {
        let compressed = image_compress::compress_image(
            &data,
            &mime,
            &CompressConfig {
                max_edge,
                byte_budget: budget as usize,
                fallback_edges: FALLBACK_EDGES_PX.to_vec(),
                jpeg_quality_steps: JPEG_QUALITY_STEPS.to_vec(),
            },
        );
        // No compression (decode failure, or an animated WebP that must not be
        // flattened): the original bytes pass through and the budget post-check
        // below still applies — v2's `passthrough`.
        match compressed {
            Some(result) => Delivered {
                delivery: if result.changed {
                    ImageDelivery::Downsampled {
                        width: result.width,
                        height: result.height,
                        mime: result.mime_type.clone(),
                        bytes: result.final_byte_length,
                    }
                } else {
                    ImageDelivery::Untouched
                },
                data: result.data,
                mime: result.mime_type,
                width: result.width,
                height: result.height,
            },
            None => {
                let (width, height) = original.map(|d| (d.width, d.height)).unwrap_or((0, 0));
                Delivered {
                    data,
                    mime: mime.clone(),
                    width,
                    height,
                    delivery: ImageDelivery::Untouched,
                }
            }
        }
    };

    // v2's post-check lives in the default branch only: `region` enforces its
    // own budget inside the crop, and `full_resolution` was gated on the fixed
    // per-image limit above.
    if !request.is_explicit()
        && (delivered.data.len() as u64 > budget
            || delivered.width.max(delivered.height) > max_edge)
    {
        return Some(err_result(delivery_limit_error(
            delivered.data.len() as u64,
            budget,
            max_edge,
        )));
    }

    let note = build_media_note(
        &mime,
        byte_size,
        original.map(|d| (d.width, d.height)),
        &delivered.delivery,
    );
    let base64 = BASE64_STANDARD.encode(&delivered.data);
    Some(ExecutableToolResult {
        stop_turn: false,
        content: format!("<image path=\"{}\">\n</image>", path.display()),
        is_error: false,
        note: Some(note),
        delivery: Some(ToolDelivery {
            blocks: vec![ContentBlock::Image {
                media_type: delivered.mime,
                data: base64,
                name: None,
            }],
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_of(width: u32, height: u32) -> Vec<u8> {
        let mut image = image::RgbaImage::new(width, height);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255]);
        }
        let mut bytes = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut bytes, image::ImageFormat::Png)
            .expect("encode png");
        bytes.into_inner()
    }

    fn temp_png(tag: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("kimi-read-media-{tag}-{}.png", fastrand::u32(..)));
        std::fs::write(&path, bytes).expect("write png");
        path
    }

    fn default_request() -> ReadMediaRequest {
        ReadMediaRequest::default()
    }

    #[test]
    fn text_files_fall_through_to_the_text_read() {
        let path = std::env::temp_dir().join(format!("kimi-read-text-{}.txt", fastrand::u32(..)));
        std::fs::write(&path, "hello world\n").unwrap();
        assert!(read_image_media(&path, &default_request(), &ReadMediaLimits::default()).is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reads_an_image_into_a_delivery_block() {
        let path = temp_png("basic", &png_of(64, 32));
        let result = read_image_media(&path, &default_request(), &ReadMediaLimits::default())
            .expect("media result");
        assert!(!result.is_error);
        assert!(result.content.contains("<image path="));
        let note = result.note.expect("note");
        assert!(note.contains("Read image file."));
        assert!(note.contains("Original dimensions: 64x32 pixels."));
        let delivery = result.delivery.expect("delivery");
        assert_eq!(delivery.blocks.len(), 1);
        match &delivery.blocks[0] {
            ContentBlock::Image { media_type, data, .. } => {
                assert_eq!(media_type, "image/png");
                assert!(!data.is_empty());
            }
            other => panic!("expected an image block, got {other:?}"),
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_declared_model_without_image_input_is_refused() {
        let path = temp_png("no-image-in", &png_of(16, 16));
        let limits = ReadMediaLimits {
            image_in: Some(false),
            ..Default::default()
        };
        let result = read_image_media(&path, &default_request(), &limits).expect("media result");
        assert!(result.is_error);
        assert!(result.content.contains("does not support image input"));
        assert!(result.delivery.is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_unsupported_mime_is_refused() {
        let path = std::env::temp_dir().join(format!("kimi-read-svg-{}.svg", fastrand::u32(..)));
        std::fs::write(&path, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>").unwrap();
        let result = read_image_media(&path, &default_request(), &ReadMediaLimits::default())
            .expect("media result");
        assert!(result.is_error);
        assert!(
            result
                .content
                .contains("which the provider does not accept")
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_tiny_budget_reports_the_delivery_limit() {
        let path = temp_png("tiny-budget", &png_of(2048, 2048));
        let limits = ReadMediaLimits {
            read_byte_budget: Some(1),
            ..Default::default()
        };
        let result = read_image_media(&path, &default_request(), &limits).expect("media result");
        assert!(result.is_error);
        assert!(result.content.contains("too large to send safely"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_region_is_cropped_and_noted() {
        let path = temp_png("region", &png_of(200, 120));
        let request = ReadMediaRequest {
            region: Some(ImageRegion {
                x: 10.0,
                y: 20.0,
                width: 40.0,
                height: 30.0,
            }),
            full_resolution: false,
        };
        let result =
            read_image_media(&path, &request, &ReadMediaLimits::default()).expect("media result");
        assert!(!result.is_error, "content: {}", result.content);
        let note = result.note.expect("note");
        assert!(
            note.contains("Showing region (x=10, y=20, width=40, height=30)"),
            "note: {note}"
        );
        assert!(note.contains("region offset (x=10, y=20)"));
        // The crop replaces the whole-image relative-coordinate hint.
        assert!(!note.contains("compute absolute coordinates using the original image size"));
        assert!(result.delivery.is_some());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_region_outside_the_image_is_refused() {
        let path = temp_png("region-oob", &png_of(64, 64));
        let request = ReadMediaRequest {
            region: Some(ImageRegion {
                x: 500.0,
                y: 500.0,
                width: 10.0,
                height: 10.0,
            }),
            full_resolution: false,
        };
        let result =
            read_image_media(&path, &request, &ReadMediaLimits::default()).expect("media result");
        assert!(result.is_error);
        assert!(
            result.content.contains("Cannot read region from"),
            "content: {}",
            result.content
        );
        assert!(result.content.contains("outside the 64x64 image"));
        assert!(result.delivery.is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_full_resolution_read_sends_the_original_bytes() {
        let bytes = png_of(48, 48);
        let path = temp_png("full-res", &bytes);
        let request = ReadMediaRequest {
            region: None,
            full_resolution: true,
        };
        let result =
            read_image_media(&path, &request, &ReadMediaLimits::default()).expect("media result");
        assert!(!result.is_error, "content: {}", result.content);
        let note = result.note.expect("note");
        assert!(note.contains("Shown at native resolution; no downscaling applied."));
        match &result.delivery.expect("delivery").blocks[0] {
            ContentBlock::Image { data, .. } => {
                assert_eq!(data, &BASE64_STANDARD.encode(&bytes));
            }
            other => panic!("expected an image block, got {other:?}"),
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_text_file_with_region_is_refused() {
        let path = std::env::temp_dir().join(format!("kimi-read-region-{}.txt", fastrand::u32(..)));
        std::fs::write(&path, "plain text\n").unwrap();
        let request = ReadMediaRequest {
            region: Some(ImageRegion {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            }),
            full_resolution: false,
        };
        let result = read_image_media(&path, &request, &ReadMediaLimits::default())
            .expect("the media path owns an explicit region call");
        assert!(result.is_error);
        assert!(result.content.contains("is a text file"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_is_model_accepted_image_mime_and_budgets() {
        assert!(is_model_accepted_image_mime("image/png", None));
        assert!(is_model_accepted_image_mime("image/jpeg", None));
        assert!(!is_model_accepted_image_mime("image/bmp", None));
        assert!(!is_model_accepted_image_mime("image/heic", None));
        assert!(!is_model_accepted_image_mime("image/heif", None));

        assert!(is_model_accepted_image_mime("image/png", Some("kimi")));
        assert!(is_model_accepted_image_mime("image/jpeg", Some("kimi")));
        assert!(is_model_accepted_image_mime("image/bmp", Some("kimi")));
        assert!(is_model_accepted_image_mime("image/heic", Some("kimi")));
        assert!(is_model_accepted_image_mime("image/heif", Some("kimi")));

        assert_eq!(inline_image_byte_budget(None), DEFAULT_INLINE_IMAGE_BYTE_BUDGET);
        assert_eq!(inline_image_byte_budget(Some("kimi")), KIMI_INLINE_IMAGE_BYTE_BUDGET);
    }

    #[test]
    fn kimi_provider_accepts_heic_while_default_refuses() {
        let path = std::env::temp_dir().join(format!("kimi-test-{}.heic", fastrand::u32(..)));
        // Write a small dummy file with HEIC magic
        let mut dummy = vec![0u8; 32];
        dummy[4..12].copy_from_slice(b"ftypheic");
        std::fs::write(&path, &dummy).unwrap();

        let request = ReadMediaRequest::default();
        // Baseline provider refuses HEIC
        let default_res = read_image_media(&path, &request, &ReadMediaLimits::default()).expect("refusal");
        assert!(default_res.is_error);
        assert!(default_res.content.contains("which the provider does not accept"));

        // Kimi provider accepts HEIC inline
        let kimi_limits = ReadMediaLimits {
            provider: Some("kimi".into()),
            ..Default::default()
        };
        let kimi_res = read_image_media(&path, &request, &kimi_limits).expect("success");
        assert!(!kimi_res.is_error);
        assert!(kimi_res.delivery.is_some());
        let delivery = kimi_res.delivery.unwrap();
        assert_eq!(delivery.blocks.len(), 1);
        match &delivery.blocks[0] {
            ContentBlock::Image { media_type, .. } => {
                assert_eq!(media_type, "image/heic");
            }
            other => panic!("expected image block, got {other:?}"),
        }

        let _ = std::fs::remove_file(&path);
    }
}
