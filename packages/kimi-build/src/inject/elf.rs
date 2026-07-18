/// Linux ELF injection using objcopy.
///
/// On Linux, the SEA blob is injected as a new ELF section.
/// We use objcopy to add the section, then set the sentinel fuse flag.

#[cfg(target_os = "linux")]
pub fn inject(input: &str, blob_data: &[u8], output: &str) -> anyhow::Result<()> {
    use std::process::Command;
    use std::fs;

    if input != output {
        fs::copy(input, output)
            .map_err(|e| anyhow::anyhow!("Failed to copy '{}' to '{}': {}", input, output, e))?;
    }

    let blob_path = format!("{}.blob.tmp", output);
    fs::write(&blob_path, blob_data)
        .map_err(|e| anyhow::anyhow!("Failed to write temp blob: {}", e))?;

    let status = Command::new("objcopy")
        .args([
            "--add-section",
            &format!("NODE_SEA_BLOB={}", blob_path),
            output,
        ])
        .status()
        .map_err(|e| anyhow::anyhow!("Failed to run objcopy: {}", e))?;

    let _ = fs::remove_file(&blob_path);

    if !status.success() {
        anyhow::bail!("objcopy --add-section failed");
    }

    println!("  Injected NODE_SEA_BLOB section ({})", blob_data.len());
    super::set_sentinel_fuse_flag(output)?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn inject(_input: &str, _blob_data: &[u8], _output: &str) -> anyhow::Result<()> {
    Err(anyhow::Error::msg(String::from("ELF injection is only supported on Linux")))
}
