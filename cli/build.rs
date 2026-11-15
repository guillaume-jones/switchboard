fn main() {
    // With LTO the engine's code never reaches the linker, so the frameworks it uses (CoreFoundation, CoreServices)
    // can be dropped, saving ~1 ms of dyld time on every hook. Not for the app, which looks some up at runtime.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg-bin=swb=-Wl,-dead_strip_dylibs");
    }
}
