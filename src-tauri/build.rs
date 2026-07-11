fn main() {
    // The macOS dev app embeds the configured icon at compile time. Track the
    // source icon files so `bun run desktop:dev` rebuilds when they change.
    println!("cargo:rerun-if-changed=icons/icon.icns");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    tauri_build::build()
}
