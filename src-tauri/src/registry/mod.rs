pub mod download;

use std::path::PathBuf;

use crate::commands::app_data_dir;

/// Local model store layout: ~/.vocalis/models/<task>/<model-id>/…
/// Tasks match spec/spec.md §5: asr-streaming, asr-batch, vad, tts, clone-tts,
/// speaker-embedding, diarization, punctuation, kws, separation, lang-id.
pub fn models_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("models"))
}

/// Resolve an installed model directory (or bare file) for a task.
pub fn resolve(task: &str, model_id: &str) -> Result<Option<PathBuf>, String> {
    let dir = models_dir()?.join(task).join(model_id);
    Ok(dir.exists().then_some(dir))
}

/// First installed model for a task — M0 fallback when config names none.
pub fn first_installed(task: &str) -> Result<Option<PathBuf>, String> {
    let task_dir = models_dir()?.join(task);
    let Ok(entries) = std::fs::read_dir(&task_dir) else {
        return Ok(None);
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    Ok(dirs.into_iter().next())
}

/// Find a file within a model dir by suffix (e.g. "encoder…onnx", "tokens.txt").
pub fn find_file(dir: &std::path::Path, contains: &str, ext: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut matches: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            name.contains(contains) && name.ends_with(ext)
        })
        .collect();
    // Prefer non-quantized names last so int8 variants win when both exist.
    matches.sort();
    matches.into_iter().next()
}
