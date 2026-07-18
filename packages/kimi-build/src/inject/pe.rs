/// Windows PE injection using Windows UpdateResource API.
///
/// On Windows, the SEA blob is stored as a custom PE resource (RT_RCDATA)
/// named "NODE_SEA_BLOB". We use the standard Windows API to add/replace
/// this resource in the executable.

#[cfg(target_os = "windows")]
pub fn inject(input: &str, blob_data: &[u8], output: &str) -> anyhow::Result<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use winapi::shared::minwindef::FALSE;
    use winapi::shared::minwindef::TRUE;
    use winapi::um::winbase::BeginUpdateResourceW;
    use winapi::um::winbase::EndUpdateResourceW;
    use winapi::um::winbase::UpdateResourceW;
    use winapi::um::winnt::MAKELANGID;
    use winapi::um::winnt::LANG_NEUTRAL;
    use winapi::um::winnt::SUBLANG_NEUTRAL;
    use winapi::um::winuser::RT_RCDATA;

    if input != output {
        std::fs::copy(input, output)
            .map_err(|e| anyhow::anyhow!("Failed to copy '{}' to '{}': {}", input, output, e))?;
    }

    let output_wide: Vec<u16> = OsStr::new(output)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let handle = unsafe { BeginUpdateResourceW(output_wide.as_ptr(), FALSE) };
    if handle.is_null() {
        anyhow::bail!(
            "BeginUpdateResourceW failed: {}",
            std::io::Error::last_os_error()
        );
    }

    let name_wide: Vec<u16> = OsStr::new("NODE_SEA_BLOB")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let result = unsafe {
        UpdateResourceW(
            handle,
            RT_RCDATA,
            name_wide.as_ptr() as _,
            MAKELANGID(LANG_NEUTRAL, SUBLANG_NEUTRAL),
            blob_data.as_ptr() as _,
            blob_data.len() as u32,
        )
    };

    if result == 0 {
        unsafe { EndUpdateResourceW(handle, TRUE) };
        anyhow::bail!(
            "UpdateResourceW failed: {}",
            std::io::Error::last_os_error()
        );
    }

    let result = unsafe { EndUpdateResourceW(handle, FALSE) };
    if result == 0 {
        anyhow::bail!(
            "EndUpdateResourceW failed: {}",
            std::io::Error::last_os_error()
        );
    }

    println!("  Injected NODE_SEA_BLOB resource ({})", blob_data.len());
    super::set_sentinel_fuse_flag(output)?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn inject(_input: &str, _blob_data: &[u8], _output: &str) -> anyhow::Result<()> {
    Err(anyhow::Error::msg(String::from("PE injection is Windows-only")))
}
