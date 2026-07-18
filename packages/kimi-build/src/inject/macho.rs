/// macOS Mach-O injection using llvm-objcopy.
///
/// On macOS, the SEA blob is injected as a new Mach-O section.
/// After injection, the code signature is invalidated and needs to be
/// removed with codesign.

#[cfg(target_os = "macos")]
pub fn inject(input: &str, blob_data: &[u8], output: &str) -> anyhow::Result<()> {
    use std::process::Command;

    if input != output {
        std::fs::copy(input, output)
            .map_err(|e| anyhow::anyhow!("Failed to copy '{}' to '{}': {}", input, output, e))?;
    }

    let status = Command::new("codesign")
        .args(["--remove-signature", output])
        .status()
        .map_err(|e| anyhow::anyhow!("Failed to run codesign: {}", e))?;

    if !status.success() {
        anyhow::bail!("codesign --remove-signature failed");
    }

    let blob_path = format!("{}.blob.tmp", output);
    std::fs::write(&blob_path, blob_data)
        .map_err(|e| anyhow::anyhow!("Failed to write temp blob: {}", e))?;

    let status = Command::new("llvm-objcopy")
        .args([
            "--add-section",
            &format!("NODE_SEA_BLOB={}", blob_path),
            "--set-section-flags",
            "NODE_SEA_BLOB=readonly",
            output,
        ])
        .status()
        .map_err(|e| anyhow::anyhow!("Failed to run llvm-objcopy: {}", e))?;

    let _ = std::fs::remove_file(&blob_path);

    if !status.success() {
        anyhow::bail!("llvm-objcopy --add-section failed");
    }

    println!("  Injected NODE_SEA_BLOB section ({})", blob_data.len());
    super::set_sentinel_fuse_flag(output)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn inject(_input: &str, _blob_data: &[u8], _output: &str) -> anyhow::Result<()> {
    Err(anyhow::Error::msg(String::from("Mach-O injection is only supported on macOS")))
}
