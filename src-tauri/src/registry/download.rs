use std::collections::HashMap;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Compiled-in catalog. `~/.vocalis/catalog.json` overrides it when present
/// and at least as new — the catalog updates independently of app releases
/// (spec §2.5).
const BUNDLED_CATALOG: &str = include_str!("../../../catalog/catalog.json");

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraFile {
    pub url: String,
    pub dest: String,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    pub task: String,
    pub name: String,
    pub description: String,
    pub languages: Vec<String>,
    pub size_bytes: u64,
    pub quantization: Option<String>,
    pub license: String,
    pub url: String,
    pub sha256: Option<String>,
    /// "tar.bz2" (unpacked with the top-level dir stripped) or "none"
    /// (single file saved as-is into the model dir).
    pub archive: String,
    pub recommended: bool,
    #[serde(default)]
    pub extra_files: Vec<ExtraFile>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub version: u32,
    pub models: Vec<CatalogModel>,
}

pub fn bundled_catalog() -> Result<Catalog, String> {
    serde_json::from_str(BUNDLED_CATALOG).map_err(|e| format!("bundled catalog invalid: {e}"))
}

/// The effective catalog: bundled, unless a valid `~/.vocalis/catalog.json`
/// override exists with version >= bundled.
pub fn load_catalog() -> Result<Catalog, String> {
    let bundled = bundled_catalog()?;
    let override_path = crate::commands::app_data_dir()?.join("catalog.json");
    Ok(pick_catalog(bundled, read_override(&override_path)))
}

fn read_override(path: &Path) -> Option<Catalog> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(catalog) => Some(catalog),
        Err(e) => {
            log::warn!(
                "[registry] ignoring invalid catalog override {}: {e}",
                path.display()
            );
            None
        }
    }
}

fn pick_catalog(bundled: Catalog, override_catalog: Option<Catalog>) -> Catalog {
    match override_catalog {
        Some(o) if o.version >= bundled.version => o,
        _ => bundled,
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub task: String,
    pub id: String,
    pub size_bytes: u64,
    /// True for user-added models (a `custom.json` marker sits in the dir) —
    /// these have no catalog entry and render with a "Custom" badge (spec §2.5).
    pub custom: bool,
    /// Friendly name from the custom marker, if any (else the UI falls back to
    /// the id).
    pub name: Option<String>,
}

/// `custom.json` written into a user-added model dir so it survives restarts
/// and deletes with the folder — no separate persisted store to orphan.
#[derive(Clone, Serialize, Deserialize)]
pub struct CustomMarker {
    pub name: String,
    /// Model family/architecture label, purely informational (the engine
    /// auto-detects weights). Optional.
    #[serde(default)]
    pub family: Option<String>,
}

pub const CUSTOM_MARKER: &str = "custom.json";

/// Turn a display name into a filesystem-safe, path-component-valid model id
/// prefixed `custom-` so it never collides with catalog ids.
pub fn slugify_custom_id(name: &str) -> String {
    let mut slug = String::from("custom-");
    let mut prev_dash = true; // avoids a leading dash right after the prefix
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    slug
}

/// Recursively copy `src` into a fresh `dest` dir (used to import a custom
/// model folder into the models store).
pub fn copy_dir_into(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let name = entry.file_name();
        let to = dest.join(&name);
        if from.is_dir() {
            copy_dir_into(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Scan models/<task>/<id>/ for installed models with their on-disk size.
/// Manually-dropped models (no manifest) count the same as downloaded ones.
pub fn installed_models(models_root: &Path) -> Vec<InstalledModel> {
    let mut out = Vec::new();
    let Ok(tasks) = std::fs::read_dir(models_root) else {
        return out;
    };
    for task_entry in tasks.filter_map(|e| e.ok()) {
        let task = task_entry.file_name().to_string_lossy().into_owned();
        if task.starts_with('.') || !task_entry.path().is_dir() {
            continue;
        }
        let Ok(models) = std::fs::read_dir(task_entry.path()) else {
            continue;
        };
        for model_entry in models.filter_map(|e| e.ok()) {
            let id = model_entry.file_name().to_string_lossy().into_owned();
            let path = model_entry.path();
            if id.starts_with('.') || !path.is_dir() {
                continue;
            }
            let marker = read_custom_marker(&path);
            out.push(InstalledModel {
                task: task.clone(),
                id,
                size_bytes: dir_size(&path),
                custom: marker.is_some(),
                name: marker.map(|m| m.name),
            });
        }
    }
    out.sort_by(|a, b| a.task.cmp(&b.task).then_with(|| a.id.cmp(&b.id)));
    out
}

/// Read a model dir's `custom.json` marker, if present and valid.
pub fn read_custom_marker(model_dir: &Path) -> Option<CustomMarker> {
    let text = std::fs::read_to_string(model_dir.join(CUSTOM_MARKER)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(|e| e.ok())
        .map(|e| {
            let p = e.path();
            if p.is_dir() {
                dir_size(&p)
            } else {
                p.metadata().map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

/// Reject model ids/tasks that could escape the models dir when joined
/// into a path.
pub fn validate_path_component(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.contains('/')
        || value.contains('\\')
        || value.contains("..")
        || value.starts_with('.')
    {
        return Err(format!("invalid model path component: {value:?}"));
    }
    Ok(())
}

pub fn delete_model(models_root: &Path, task: &str, id: &str) -> Result<(), String> {
    validate_path_component(task)?;
    validate_path_component(id)?;
    let dir = models_root.join(task).join(id);
    if !dir.is_dir() {
        return Err(format!("model not installed: {task}/{id}"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

/// Events streamed to the webview over a Tauri channel during a download.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DownloadEvent {
    Progress { received: u64, total: u64 },
    Extracting,
    Done,
    Error { message: String },
}

/// Managed state: in-flight downloads by model id, cancelable via an atomic
/// flag — same shape as pipeline::PipelineRegistry.
#[derive(Default)]
pub struct DownloadRegistry {
    flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl DownloadRegistry {
    /// Claim a download slot; errors if the model is already downloading.
    pub fn begin(&self, model_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut flags = self.flags.lock().unwrap();
        if flags.contains_key(model_id) {
            return Err(format!("{model_id} is already downloading"));
        }
        let flag = Arc::new(AtomicBool::new(false));
        flags.insert(model_id.to_string(), flag.clone());
        Ok(flag)
    }

    pub fn cancel(&self, model_id: &str) -> bool {
        match self.flags.lock().unwrap().get(model_id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    pub fn finish(&self, model_id: &str) {
        self.flags.lock().unwrap().remove(model_id);
    }
}

/// Download a catalog model into models/<task>/<id>/. Emits Progress and
/// Extracting events; Done/Error are the caller's responsibility (the command
/// emits them after cleanup). On any failure the partially-written model dir
/// is removed so installs are all-or-nothing.
pub async fn download_model(
    model: &CatalogModel,
    models_root: &Path,
    cancel: &AtomicBool,
    emit: &(dyn Fn(DownloadEvent) + Send + Sync),
) -> Result<(), String> {
    validate_path_component(&model.task)?;
    validate_path_component(&model.id)?;
    let task_dir = models_root.join(&model.task);
    std::fs::create_dir_all(&task_dir).map_err(|e| e.to_string())?;
    let dest_dir = task_dir.join(&model.id);
    let part_path = task_dir.join(format!(".{}.part", model.id));

    let result = run_download(model, &dest_dir, &part_path, cancel, emit).await;
    let _ = std::fs::remove_file(&part_path);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&dest_dir);
    }
    result
}

async fn run_download(
    model: &CatalogModel,
    dest_dir: &Path,
    part_path: &Path,
    cancel: &AtomicBool,
    emit: &(dyn Fn(DownloadEvent) + Send + Sync),
) -> Result<(), String> {
    fetch_to_file(
        &model.url,
        part_path,
        model.sha256.as_deref(),
        cancel,
        &|received, total| {
            emit(DownloadEvent::Progress { received, total });
        },
    )
    .await?;

    if model.archive == "tar.bz2" {
        emit(DownloadEvent::Extracting);
        let archive = part_path.to_path_buf();
        let dest = dest_dir.to_path_buf();
        tokio::task::spawn_blocking(move || unpack_tar_bz2_strip1(&archive, &dest))
            .await
            .map_err(|e| format!("extract task failed: {e}"))??;
    } else {
        std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
        let filename = model.url.rsplit('/').next().unwrap_or(&model.id);
        std::fs::rename(part_path, dest_dir.join(filename)).map_err(|e| e.to_string())?;
    }

    for extra in &model.extra_files {
        validate_path_component(&extra.dest)?;
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        fetch_to_file(
            &extra.url,
            part_path,
            extra.sha256.as_deref(),
            cancel,
            &|received, total| {
                emit(DownloadEvent::Progress { received, total });
            },
        )
        .await?;
        std::fs::rename(part_path, dest_dir.join(&extra.dest)).map_err(|e| e.to_string())?;
    }

    Ok(())
}

async fn fetch_to_file(
    url: &str,
    path: &Path,
    expected_sha256: Option<&str>,
    cancel: &AtomicBool,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<(), String> {
    let response = reqwest::get(url)
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("{url}: HTTP {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);

    let mut file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_emitted: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let chunk = chunk.map_err(|e| format!("download interrupted: {e}"))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        received += chunk.len() as u64;
        // Throttle IPC: one progress event per MiB is plenty for a bar.
        if received - last_emitted >= 1024 * 1024 {
            progress(received, total);
            last_emitted = received;
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    if last_emitted != received {
        progress(received, total);
    }

    if let Some(expected) = expected_sha256 {
        let actual = format!("{:x}", hasher.finalize());
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(format!(
                "sha256 mismatch for {url}: expected {expected}, got {actual}"
            ));
        }
    }
    Ok(())
}

/// Unpack a .tar.bz2, stripping the archive's single top-level directory so
/// files land directly in `dest`. Only plain relative paths are allowed —
/// absolute/`..` entries are rejected (tarbomb protection).
fn unpack_tar_bz2_strip1(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut ar = tar::Archive::new(bzip2::read::BzDecoder::new(file));
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;

    for entry in ar.entries().map_err(|e| format!("bad archive: {e}"))? {
        let mut entry = entry.map_err(|e| format!("bad archive entry: {e}"))?;
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            continue; // pax headers, links — nothing sherpa models need
        }

        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        let mut components = path
            .components()
            .filter(|c| !matches!(c, Component::CurDir));
        components.next(); // drop the tarball's top-level dir
        let mut stripped = PathBuf::new();
        for component in components {
            match component {
                Component::Normal(part) => stripped.push(part),
                _ => return Err(format!("unsafe path in archive: {}", path.display())),
            }
        }
        if stripped.as_os_str().is_empty() {
            continue;
        }

        let out = dest.join(&stripped);
        if entry_type.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        entry
            .unpack(&out)
            .map_err(|e| format!("failed to unpack {}: {e}", out.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNOWN_TASKS: &[&str] = &[
        "asr-streaming",
        "asr-batch",
        "vad",
        "tts",
        "clone-tts",
        "speaker-embedding",
        "diarization",
        "punctuation",
        "kws",
        "separation",
        "lang-id",
    ];

    #[test]
    fn bundled_catalog_parses_and_is_sane() {
        let catalog = bundled_catalog().expect("bundled catalog must parse");
        assert_eq!(catalog.version, 1);
        assert!(!catalog.models.is_empty());

        let mut ids = std::collections::HashSet::new();
        for model in &catalog.models {
            assert!(ids.insert(model.id.clone()), "duplicate id {}", model.id);
            assert!(
                KNOWN_TASKS.contains(&model.task.as_str()),
                "unknown task {}",
                model.task
            );
            assert!(
                matches!(model.archive.as_str(), "tar.bz2" | "none"),
                "bad archive in {}",
                model.id
            );
            assert!(
                model.url.starts_with("https://"),
                "non-https url in {}",
                model.id
            );
            assert!(model.size_bytes > 0, "zero size in {}", model.id);
            validate_path_component(&model.id).unwrap();
            validate_path_component(&model.task).unwrap();
            // Spec §5: every entry ships with a pinned checksum.
            let sha = model
                .sha256
                .as_deref()
                .unwrap_or_else(|| panic!("unpinned sha256 in {}", model.id));
            assert!(
                sha.len() == 64 && sha.chars().all(|c| c.is_ascii_hexdigit()),
                "malformed sha256 in {}",
                model.id
            );
            for extra in &model.extra_files {
                validate_path_component(&extra.dest).unwrap();
            }
        }
    }

    #[test]
    fn bundled_catalog_covers_every_known_task() {
        // spec §2.5 / M2 item 10: every local task ships with at least one
        // catalog entry so the Models view has an active-slot row for it.
        let catalog = bundled_catalog().unwrap();
        for task in KNOWN_TASKS {
            assert!(
                catalog.models.iter().any(|m| m.task == *task),
                "no catalog entry for task {task}"
            );
        }
    }

    #[test]
    fn pick_catalog_prefers_newer_or_equal_override() {
        let bundled = Catalog {
            version: 2,
            models: vec![],
        };
        let newer = Catalog {
            version: 3,
            models: vec![],
        };
        let older = Catalog {
            version: 1,
            models: vec![],
        };

        assert_eq!(pick_catalog(bundled.clone(), Some(newer)).version, 3);
        assert_eq!(pick_catalog(bundled.clone(), Some(older)).version, 2);
        assert_eq!(pick_catalog(bundled, None).version, 2);
    }

    #[test]
    fn validate_path_component_rejects_escapes() {
        for bad in ["", "a/b", "a\\b", "..", "a..b", ".hidden", "../x"] {
            assert!(
                validate_path_component(bad).is_err(),
                "{bad:?} should be rejected"
            );
        }
        for good in ["kokoro-en-v0_19", "silero-vad-v5", "whisper-small-int8"] {
            assert!(
                validate_path_component(good).is_ok(),
                "{good:?} should be accepted"
            );
        }
    }

    #[test]
    fn installed_models_scans_and_sizes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("vad/silero-vad-v5")).unwrap();
        std::fs::write(root.join("vad/silero-vad-v5/model.onnx"), [0u8; 100]).unwrap();
        std::fs::create_dir_all(root.join("tts/kokoro/voices")).unwrap();
        std::fs::write(root.join("tts/kokoro/model.onnx"), [0u8; 10]).unwrap();
        std::fs::write(root.join("tts/kokoro/voices/a.bin"), [0u8; 5]).unwrap();
        // Noise that must be ignored: hidden dirs, partial downloads, loose files.
        std::fs::create_dir_all(root.join(".hidden/x")).unwrap();
        std::fs::write(root.join("tts/.kokoro.part"), [0u8; 999]).unwrap();
        std::fs::write(root.join("stray.txt"), [0u8; 999]).unwrap();

        let installed = installed_models(root);
        assert_eq!(installed.len(), 2);
        assert_eq!(installed[0].task, "tts");
        assert_eq!(installed[0].id, "kokoro");
        assert_eq!(installed[0].size_bytes, 15);
        assert_eq!(installed[1].task, "vad");
        assert_eq!(installed[1].size_bytes, 100);
    }

    #[test]
    fn installed_models_on_missing_root_is_empty() {
        assert!(installed_models(Path::new("/nonexistent/nope")).is_empty());
    }

    #[test]
    fn slugify_custom_id_is_path_safe_and_prefixed() {
        assert_eq!(slugify_custom_id("My Cool Model"), "custom-my-cool-model");
        assert_eq!(slugify_custom_id("  Whisper v3!!  "), "custom-whisper-v3");
        assert_eq!(slugify_custom_id("a/../b"), "custom-a-b");
        assert_eq!(slugify_custom_id("***"), "custom");
        for name in ["My Cool Model", "a/../b", "***", "café münchen"] {
            validate_path_component(&slugify_custom_id(name))
                .unwrap_or_else(|_| panic!("slug of {name:?} must be a valid path component"));
        }
    }

    #[test]
    fn copy_dir_and_custom_marker_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("model.onnx"), [7u8; 20]).unwrap();
        std::fs::write(src.join("sub/tokens.txt"), b"hi").unwrap();

        let root = tmp.path().join("models");
        let dest = root.join("tts/custom-my-voice");
        copy_dir_into(&src, &dest).unwrap();
        assert_eq!(std::fs::read(dest.join("model.onnx")).unwrap().len(), 20);
        assert_eq!(std::fs::read(dest.join("sub/tokens.txt")).unwrap(), b"hi");

        // No marker yet → not custom.
        assert!(read_custom_marker(&dest).is_none());
        let listed = installed_models(&root);
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].custom);
        assert_eq!(listed[0].name, None);

        // Write a marker → installed_models reports it as custom with a name.
        std::fs::write(
            dest.join(CUSTOM_MARKER),
            serde_json::to_string(&CustomMarker {
                name: "My Voice".into(),
                family: Some("kokoro".into()),
            })
            .unwrap(),
        )
        .unwrap();
        let listed = installed_models(&root);
        assert!(listed[0].custom);
        assert_eq!(listed[0].name.as_deref(), Some("My Voice"));
    }

    #[test]
    fn delete_model_removes_dir_and_validates() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("tts/kokoro")).unwrap();

        assert!(delete_model(root, "tts", "../kokoro").is_err());
        assert!(delete_model(root, "tts", "missing").is_err());
        delete_model(root, "tts", "kokoro").unwrap();
        assert!(!root.join("tts/kokoro").exists());
    }

    #[test]
    fn download_registry_tracks_and_cancels() {
        let registry = DownloadRegistry::default();
        let flag = registry.begin("m1").unwrap();
        assert!(
            registry.begin("m1").is_err(),
            "double download must be rejected"
        );
        assert!(!flag.load(Ordering::Relaxed));
        assert!(registry.cancel("m1"));
        assert!(flag.load(Ordering::Relaxed));
        registry.finish("m1");
        assert!(!registry.cancel("m1"));
        assert!(registry.begin("m1").is_ok(), "finished id can restart");
    }

    #[test]
    fn unpack_strips_top_level_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let archive_path = tmp.path().join("model.tar.bz2");

        let file = std::fs::File::create(&archive_path).unwrap();
        let encoder = bzip2::write::BzEncoder::new(file, bzip2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_size(5);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header.clone(), "top-dir/tokens.txt", &b"hello"[..])
            .unwrap();
        builder
            .append_data(&mut header, "top-dir/sub/model.onnx", &b"world"[..])
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap();

        let dest = tmp.path().join("out");
        unpack_tar_bz2_strip1(&archive_path, &dest).unwrap();
        assert_eq!(std::fs::read(dest.join("tokens.txt")).unwrap(), b"hello");
        assert_eq!(
            std::fs::read(dest.join("sub/model.onnx")).unwrap(),
            b"world"
        );
        assert!(!dest.join("top-dir").exists());
    }
}
