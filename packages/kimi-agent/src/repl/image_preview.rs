//! Inline image preview for the standalone REPL.
//!
//! The product frontends render the pictures a tool returns as part of their
//! transcript. A line-oriented REPL has no transcript to re-render, so it
//! writes each picture as one self-contained block the moment the tool result
//! lands: `repl::terminal_image` owns the escape sequences and the parity with
//! pi-tui, this module owns what to show and what to say when the terminal
//! cannot show anything.
//!
//! The seam is a decorator on [`HostCallbacks`] rather than a new event: the
//! `tool.native` event carries text only (`ToolNative.content`), while the
//! image bytes ride `ToolExecuteResponse.delivery`, which the engine consumes
//! as the follow-up user message. Nothing outside the REPL sees this.

use std::io::Write;
use std::sync::Arc;

use crate::callbacks::HostCallbacks;
use crate::rpc::types::{
    AskQuestionRequest, AskQuestionResponse, BoxFuture, CheckpointRequest, ContentBlock,
    ListToolsResponse, LlmChatRequest, LlmChatResponse, PermissionCheckRequest, PermissionDecision,
    StateReadRequest, StateReadResponse, StateWriteRequest, StateWriteResponse, ToolExecuteRequest,
    ToolExecuteResponse,
};

use super::terminal_image;

/// Inline pictures are sized against the terminal's own width, which the
/// standalone REPL cannot query (no terminal-control dependency, and the ANSI
/// cursor-report round trip would have to be read mid-turn). `COLUMNS` is what
/// a shell exports when it exports anything; pi-tui's own default for inline
/// rendering — 80 cells — is the fallback.
const FALLBACK_WIDTH_CELLS: u32 = 80;

/// Wrap a tool-callback chain so the images in each tool result are painted
/// into the REPL's scrollback.
pub struct ImagePreviewCallbacks {
    inner: Arc<dyn HostCallbacks>,
}

impl ImagePreviewCallbacks {
    pub fn new(inner: Arc<dyn HostCallbacks>) -> Self {
        Self { inner }
    }
}

impl HostCallbacks for ImagePreviewCallbacks {
    fn llm_chat(
        &self,
        request: LlmChatRequest,
    ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
        self.inner.llm_chat(request)
    }

    fn execute_tool(
        &self,
        request: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        let inner = self.inner.clone();
        Box::pin(async move {
            let response = inner.execute_tool(request).await?;
            render_tool_images(&response);
            Ok(response)
        })
    }

    fn owns_tool(&self, tool_name: &str) -> bool {
        self.inner.owns_tool(tool_name)
    }

    fn check_permission(
        &self,
        request: PermissionCheckRequest,
    ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
        self.inner.check_permission(request)
    }

    fn ask_question(
        &self,
        request: AskQuestionRequest,
    ) -> BoxFuture<'static, Result<AskQuestionResponse, String>> {
        self.inner.ask_question(request)
    }

    fn state_read(
        &self,
        request: StateReadRequest,
    ) -> BoxFuture<'static, Result<StateReadResponse, String>> {
        self.inner.state_read(request)
    }

    fn state_write(
        &self,
        request: StateWriteRequest,
    ) -> BoxFuture<'static, Result<StateWriteResponse, String>> {
        self.inner.state_write(request)
    }

    fn checkpoint(&self, request: CheckpointRequest) -> BoxFuture<'static, Result<(), String>> {
        self.inner.checkpoint(request)
    }

    fn list_tools(&self) -> BoxFuture<'static, Result<ListToolsResponse, String>> {
        self.inner.list_tools()
    }

    fn goal(
        &self,
    ) -> BoxFuture<'static, Result<Option<crate::turn_loop::types::GoalContext>, String>> {
        self.inner.goal()
    }

    fn auth_token(
        &self,
        provider: String,
        force: bool,
    ) -> BoxFuture<'static, Result<String, String>> {
        self.inner.auth_token(provider, force)
    }

    fn set_file_history(
        &self,
        store: Arc<crate::session::sqlite_store::SqliteSessionStore>,
        session_id: String,
        turn_id: usize,
    ) {
        self.inner.set_file_history(store, session_id, turn_id);
    }

    fn drain_steers(
        &self,
    ) -> BoxFuture<'static, Result<Vec<crate::turn_loop::types::LLMMessage>, String>> {
        self.inner.drain_steers()
    }

    fn set_turn_goal(&self, turn_id: &str, goal_id: Option<&str>) {
        self.inner.set_turn_goal(turn_id, goal_id);
    }

    fn emit_event(&self, event: serde_json::Value) {
        self.inner.emit_event(event);
    }

    fn turn_event(&self, event: crate::turn_events::TurnEvent) {
        self.inner.turn_event(event);
    }

    fn telemetry(&self, event: serde_json::Value) {
        self.inner.telemetry(event);
    }
}

/// Paint every image the tool result carries.
///
/// The native Read tool attaches at most one picture per result, and the engine
/// applies the configured image byte/edge budget before the block is built, so
/// there is no second limit to enforce here.
fn render_tool_images(response: &ToolExecuteResponse) {
    let Some(delivery) = response.delivery.as_ref() else {
        return;
    };
    for block in &delivery.blocks {
        let ContentBlock::Image {
            data,
            media_type,
            name,
        } = block
        else {
            continue;
        };
        render_image(data, media_type, name.as_deref());
    }
}

/// Write one picture as a self-contained block, or one metadata line when the
/// terminal cannot display it — the fallback the product frontends show too.
fn render_image(base64: &str, media_type: &str, name: Option<&str>) {
    let dimensions = image_dimensions(base64);
    let cell_px = (
        terminal_image::DEFAULT_CELL_WIDTH_PX,
        terminal_image::DEFAULT_CELL_HEIGHT_PX,
    );
    let max_width = preview_width_cells();
    let size = dimensions.map(|(width, height)| {
        terminal_image::calculate_image_cell_size((width, height), max_width, None, cell_px)
    });

    let protocol = terminal_image::resolve_protocol(&terminal_image::ProbeEnv::from_process());
    let sequence = match (protocol, dimensions) {
        (Some(terminal_image::ImageProtocol::Kitty), Some(_)) => size
            .map(|size| terminal_image::encode_kitty(base64, size.columns, size.rows, None, true)),
        (Some(terminal_image::ImageProtocol::Iterm2), Some(_)) => {
            size.map(|size| terminal_image::encode_iterm2(base64, size.columns))
        }
        (Some(terminal_image::ImageProtocol::Sixel), Some((width, height))) => rgba_pixels(base64)
            .map(|pixels| {
                terminal_image::encode_sixel(&pixels, width, height, max_width, None, cell_px)
            }),
        _ => None,
    };

    let stdout = std::io::stdout();
    let mut writer = stdout.lock();
    match sequence.filter(|sequence| !sequence.is_empty()) {
        Some(sequence) => {
            let _ = terminal_image::write_block(&mut writer, &sequence);
            let _ = writeln!(writer);
        }
        None => {
            let label = name.unwrap_or(media_type);
            match dimensions {
                Some((width, height)) => {
                    let _ = writeln!(writer, "[image: {label} ({width}x{height})]");
                }
                None => {
                    let _ = writeln!(writer, "[image: {label}]");
                }
            }
        }
    }
    let _ = writer.flush();
}

/// The inline width budget: `COLUMNS` when the environment exports it, pi-tui's
/// 80-cell default otherwise.
fn preview_width_cells() -> u32 {
    std::env::var("COLUMNS")
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|columns| *columns > 0)
        .unwrap_or(FALLBACK_WIDTH_CELLS)
}

/// Decode a base64 image payload into bytes.
fn decode_base64(base64: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(base64)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(base64))
        .ok()
}

/// The picture's pixel dimensions, read from the header alone — the Kitty and
/// iTerm2 paths need the size to place a picture but never the pixels.
fn image_dimensions(base64: &str) -> Option<(u32, u32)> {
    let bytes = decode_base64(base64)?;
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    reader.into_dimensions().ok()
}

/// Fully decoded RGBA8 pixels, row-major — what the sixel encoder quantises.
fn rgba_pixels(base64: &str) -> Option<Vec<u8>> {
    let bytes = decode_base64(base64)?;
    let decoded = image::load_from_memory(&bytes).ok()?;
    Some(decoded.to_rgba8().into_raw())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 2x2 PNG — red on the left, blue on the right — small enough to read
    /// and real enough to exercise the header and pixel paths.
    fn png_fixture_base64() -> String {
        let mut image = image::RgbaImage::new(2, 2);
        image.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        image.put_pixel(1, 0, image::Rgba([0, 0, 255, 255]));
        image.put_pixel(0, 1, image::Rgba([255, 0, 0, 255]));
        image.put_pixel(1, 1, image::Rgba([0, 0, 255, 255]));
        let mut bytes = Vec::new();
        image
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .expect("the fixture encodes");
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn dimensions_come_from_the_header_without_decoding_pixels() {
        let encoded = png_fixture_base64();
        assert_eq!(image_dimensions(&encoded), Some((2, 2)));
    }

    #[test]
    fn pixels_decode_to_row_major_rgba() {
        let encoded = png_fixture_base64();
        let pixels = rgba_pixels(&encoded).expect("the fixture decodes");
        assert_eq!(pixels.len(), 2 * 2 * 4);
        assert_eq!(&pixels[..4], &[255, 0, 0, 255], "top-left is red");
        assert_eq!(&pixels[4..8], &[0, 0, 255, 255], "top-right is blue");
    }

    #[test]
    fn an_undecodable_payload_reports_no_picture() {
        assert_eq!(image_dimensions("not base64 at all"), None);
        assert_eq!(rgba_pixels("bm90IGFuIGltYWdl"), None);
    }

    #[test]
    fn a_tool_result_without_delivery_paints_nothing() {
        // No image block to find is the common case; the walk must be a no-op
        // rather than a scan that finds a stale one.
        let response = ToolExecuteResponse {
            content: "ok".to_string(),
            is_error: false,
            note: None,
            stop_turn: false,
            delivery: None,
        };
        render_tool_images(&response);
    }

    #[test]
    fn the_width_budget_is_never_zero() {
        // A zero width would size every picture to a zero-column cell block,
        // which renders as nothing at all.
        assert!(preview_width_cells() > 0);
    }
}
