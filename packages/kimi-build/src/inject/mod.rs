pub mod pe;
#[cfg(target_os = "macos")]
pub mod macho;
#[cfg(target_os = "linux")]
pub mod elf;

use std::path::Path;

/// Run the injection: detect format and dispatch to the platform-specific handler.
pub fn run(input: &str, blob: &str, output: &str) -> anyhow::Result<()> {
    let blob_data = std::fs::read(blob)
        .map_err(|e| anyhow::anyhow!("Failed to read blob file '{}': {}", blob, e))?;

    let input_path = Path::new(input);
    let exe_data = std::fs::read(input_path)
        .map_err(|e| anyhow::anyhow!("Failed to read input executable '{}': {}", input, e))?;

    // Detect format by examining the file header
    if is_pe(&exe_data) {
        pe::inject(input, &blob_data, output)?;
    } else if is_macho(&exe_data) {
        #[cfg(target_os = "macos")]
        {
            macho::inject(input, &blob_data, output)?;
        }
        #[cfg(not(target_os = "macos"))]
        {
            anyhow::bail!("Mach-O injection is only supported on macOS");
        }
    } else if is_elf(&exe_data) {
        #[cfg(target_os = "linux")]
        {
            elf::inject(input, &blob_data, output)?;
        }
        #[cfg(not(target_os = "linux"))]
        {
            anyhow::bail!("ELF injection is only supported on Linux");
        }
    } else {
        anyhow::bail!(
            "Unrecognized executable format. Supported: PE (Windows), Mach-O (macOS), ELF (Linux)"
        );
    }

    Ok(())
}

/// Check if the data starts with a PE header (MZ magic).
fn is_pe(data: &[u8]) -> bool {
    data.len() >= 2 && data[0] == b'M' && data[1] == b'Z'
}

/// Check if the data starts with a Mach-O header.
fn is_macho(data: &[u8]) -> bool {
    if data.len() < 4 {
        return false;
    }
    // 32-bit: FE ED FA CE, 64-bit: FE ED FA CF
    // Reverse byte order: CE FA ED FE, CF FA ED FE
    let magic = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    matches!(magic, 0xFEEDFACE | 0xFEEDFACF | 0xCEFAEDFE | 0xCFFAEDFE)
}

/// Check if the data starts with an ELF header.
fn is_elf(data: &[u8]) -> bool {
    data.len() >= 4 && data[0] == 0x7F && data[1] == b'E' && data[2] == b'L' && data[3] == b'F'
}

/// After the NODE_SEA_BLOB resource/section is injected, flip the sentinel
/// fuse byte from '0' to '1' so Node.js recognises the binary as a SEA app.
///
/// Node.js embeds the sentinel fuse string in its binary:
///   "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:0"
/// The last byte is '0' before injection, '1' after. This function finds
/// the sentinel in the binary and flips the flag byte.
pub fn set_sentinel_fuse_flag(output: &str) -> anyhow::Result<()> {
    const SENTINEL_FUSE: &[u8] = b"NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

    let mut binary = std::fs::read(output)
        .map_err(|e| anyhow::anyhow!("Failed to read back '{}': {}", output, e))?;

    let pos = binary
        .windows(SENTINEL_FUSE.len())
        .position(|window| window == SENTINEL_FUSE)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Sentinel fuse not found in '{}'. Is this a Node.js SEA-enabled binary?",
                output
            )
        })?;

    let colon_pos = pos + SENTINEL_FUSE.len();
    if colon_pos >= binary.len() || binary[colon_pos] != b':' {
        anyhow::bail!(
            "Expected ':' after sentinel fuse at offset {} in '{}', got byte {:02x}",
            colon_pos,
            output,
            binary.get(colon_pos).copied().unwrap_or(0),
        );
    }

    let flag_pos = colon_pos + 1;
    if flag_pos >= binary.len() {
        anyhow::bail!("Unexpected EOF after sentinel fuse colon in '{}'", output);
    }

    match binary[flag_pos] {
        b'1' => {
            println!("  Sentinel fuse already active");
        }
        b'0' => {
            binary[flag_pos] = b'1';
            std::fs::write(output, &binary)
                .map_err(|e| anyhow::anyhow!("Failed to write back '{}': {}", output, e))?;
            println!("  Sentinel fuse activated");
        }
        other => {
            anyhow::bail!(
                "Unexpected sentinel fuse value {:02x} at offset {} in '{}'",
                other,
                flag_pos,
                output,
            );
        }
    }

    Ok(())
}