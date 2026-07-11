fn main() {
    // napi_build::setup() requires libnode.dll at build time on Windows to
    // generate an import library. On systems where Node.js is statically
    // linked (no standalone libnode.dll), we skip this step — the NAPI
    // symbols are resolved at runtime by the Node.js process that loads
    // the .node file.
    //
    // The only thing napi_build::setup() does beyond libnode is set
    // cargo:cfg flags for napi-derive, which we replicate here.
    println!("cargo:rerun-if-env-changed=DEBUG_GENERATED_CODE");
    println!("cargo:rerun-if-env-changed=TYPE_DEF_TMP_PATH");
    println!("cargo:rerun-if-env-changed=CARGO_CFG_NAPI_RS_CLI_VERSION");
    println!("cargo::rerun-if-env-changed=NAPI_DEBUG_GENERATED_CODE");
    println!("cargo:rerun-if-env-changed=NAPI_TYPE_DEF_TMP_FOLDER");
    println!("cargo:rerun-if-env-changed=NAPI_FORCE_BUILD_KIMI_NATIVE_TOOLS");

    // Link against node's import library if available (napi-build looks for
    // libnode.dll in PATH and system directories). If not found, the .node
    // will still work because Node.js provides the symbols at runtime.
    #[cfg(target_os = "windows")]
    {
        // Try to find libnode.dll — some Node.js distributions ship it.
        if let Some(node_dir) = std::env::var_os("NODE_DIR") {
            let lib_path = std::path::Path::new(&node_dir).join("libnode.dll");
            if lib_path.exists() {
                println!("cargo:rustc-link-lib=dylib=node");
                println!("cargo:rustc-link-search=native={}", node_dir.to_string_lossy());
            }
        }
    }
}
