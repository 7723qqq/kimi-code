#![deny(clippy::all)]

mod bash;
mod edit;
mod file_type;
mod glob;
mod grep;
mod line_endings;
mod napi_bindings;
mod read;
mod write;

pub use napi_bindings::*;
