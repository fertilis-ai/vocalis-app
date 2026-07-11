//! Real-network download test — exercises the full fetch → unpack path
//! against GitHub releases. Run explicitly:
//!
//!   cargo test --test download_real -- --ignored

use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use vocalis_lib::registry::download::{bundled_catalog, download_model, DownloadEvent};

#[tokio::test]
#[ignore = "downloads ~67 MB from GitHub"]
async fn downloads_and_unpacks_piper_fr() {
    let catalog = bundled_catalog().unwrap();
    let model = catalog
        .models
        .iter()
        .find(|m| m.id == "piper-fr-siwis")
        .expect("piper-fr-siwis in bundled catalog");

    let tmp = tempfile::tempdir().unwrap();
    let cancel = AtomicBool::new(false);
    let events: Mutex<Vec<DownloadEvent>> = Mutex::new(Vec::new());

    download_model(model, tmp.path(), &cancel, &|event| {
        events.lock().unwrap().push(event);
    })
    .await
    .expect("download should succeed");

    let dir = tmp.path().join("tts/piper-fr-siwis");
    let onnx = dir.join("fr_FR-siwis-medium.onnx");
    let tokens = dir.join("tokens.txt");
    assert!(onnx.is_file(), "missing {}", onnx.display());
    assert!(onnx.metadata().unwrap().len() > 10_000_000, "onnx suspiciously small");
    assert!(tokens.is_file(), "missing {}", tokens.display());
    assert!(tokens.metadata().unwrap().len() > 0, "tokens.txt empty");
    // Top-level archive dir must have been stripped away.
    assert!(!dir.join("vits-piper-fr_FR-siwis-medium").exists());

    let events = events.lock().unwrap();
    assert!(
        events.iter().any(|e| matches!(e, DownloadEvent::Progress { .. })),
        "no progress events emitted"
    );
    assert!(
        events.iter().any(|e| matches!(e, DownloadEvent::Extracting)),
        "no extracting event emitted"
    );
}
