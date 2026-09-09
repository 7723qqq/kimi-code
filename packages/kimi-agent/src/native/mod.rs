#![cfg_attr(not(feature = "napi"), allow(dead_code, unused_imports, unused_variables))]

mod bash;
mod bash_spawn;
mod compaction;
mod edit;
mod encoding;
mod escape;
mod fetch_url;
mod file_cache;
mod file_type;
mod glob;
pub mod goal;
mod grep;
mod image_compress;
mod line_endings;
pub mod list_directory;
mod llm_stream;
#[cfg(feature = "napi")]
mod napi_bindings;
mod output_truncate;
mod path_access;
mod permission;
mod read;
mod tokens;
mod tool_access;
pub(crate) mod tool_naming;
mod translation;
mod web_search;
mod workspace_index;
mod write;

pub mod event_store;
pub mod lsp;
pub mod permission_engine;

pub use list_directory::{list_directory, ListDirectoryConfig, ListDirectoryResult};

pub fn native_list_directory(
    path: Option<String>,
    collapse_hidden_dirs: Option<bool>,
) -> ListDirectoryResult {
    list_directory::list_directory(&ListDirectoryConfig {
        path,
        collapse_hidden_dirs: collapse_hidden_dirs.unwrap_or(false),
    })
}

#[cfg(feature = "napi")]
pub use napi_bindings::*;