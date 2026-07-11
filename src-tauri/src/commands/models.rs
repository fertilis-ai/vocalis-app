use std::path::{Path, PathBuf};

use tauri::ipc::Channel;
use tauri::State;

use crate::engines::{
    Diarizer, KeywordSession, LangIdentifier, OfflineAsr, Punctuator, SourceSeparator,
    SpeakerEmbedder, SpeechDetector, StreamingAsrSession, TtsEngine,
};
use crate::registry::{
    self,
    download::{Catalog, CustomMarker, DownloadEvent, DownloadRegistry, InstalledModel},
};
use crate::state::SpeechState;

/// Threads for the throwaway load used to validate a custom model — small, it
/// only proves the weights parse.
const VALIDATE_THREADS: i32 = 2;

/// Attempt to construct the engine for `task` against a candidate model dir.
/// Each engine's `new` performs the real file/shape checks, so a successful
/// build *is* the validation (spec §2.5). Ok means the model loads.
fn validate_model_load(task: &str, dir: &Path) -> Result<(), String> {
    match task {
        "vad" => {
            let file = registry::find_file(dir, "", ".onnx")
                .ok_or("no .onnx model file found in the folder")?;
            SpeechDetector::new(&file).map(drop)
        }
        "asr-streaming" => StreamingAsrSession::new(dir, VALIDATE_THREADS).map(drop),
        "asr-batch" => OfflineAsr::new(dir, VALIDATE_THREADS, None).map(drop),
        "tts" => TtsEngine::new(dir, VALIDATE_THREADS).map(drop),
        "lang-id" => LangIdentifier::new(dir, VALIDATE_THREADS).map(drop),
        "punctuation" => Punctuator::new(dir, VALIDATE_THREADS).map(drop),
        "speaker-embedding" => SpeakerEmbedder::new(dir, VALIDATE_THREADS).map(drop),
        "separation" => SourceSeparator::new(dir, VALIDATE_THREADS).map(drop),
        "kws" => KeywordSession::new(dir, VALIDATE_THREADS, 1.0, "").map(drop),
        "diarization" => {
            let embedding = registry::first_installed("speaker-embedding")?.ok_or(
                "diarization needs an installed speaker-embedding model to validate against",
            )?;
            Diarizer::new(dir, &embedding, VALIDATE_THREADS).map(drop)
        }
        other => Err(format!("custom models aren't supported for task \"{other}\"")),
    }
}

#[tauri::command]
pub fn models_catalog() -> Result<Catalog, String> {
    registry::download::load_catalog()
}

#[tauri::command]
pub fn models_installed() -> Result<Vec<InstalledModel>, String> {
    Ok(registry::download::installed_models(
        &registry::models_dir()?
    ))
}

/// Download a catalog model, streaming progress over the channel. Download
/// failures are reported as channel Error events (the command still resolves
/// Ok); only pre-flight problems reject the invoke.
#[tauri::command]
pub async fn model_download(
    state: State<'_, DownloadRegistry>,
    channel: Channel<DownloadEvent>,
    model_id: String,
) -> Result<(), String> {
    let catalog = registry::download::load_catalog()?;
    let model = catalog
        .models
        .iter()
        .find(|m| m.id == model_id)
        .ok_or_else(|| format!("unknown model id: {model_id}"))?
        .clone();
    let models_root = registry::models_dir()?;
    let cancel = state.begin(&model_id)?;

    log::info!(
        "[registry] downloading {}/{} from {}",
        model.task,
        model.id,
        model.url
    );
    let emit = |event: DownloadEvent| {
        let _ = channel.send(event);
    };
    let result = registry::download::download_model(&model, &models_root, &cancel, &emit).await;
    state.finish(&model_id);

    match result {
        Ok(()) => {
            log::info!("[registry] installed {}/{}", model.task, model.id);
            emit(DownloadEvent::Done);
        }
        Err(message) => {
            log::warn!("[registry] download of {} failed: {message}", model.id);
            emit(DownloadEvent::Error { message });
        }
    }
    Ok(())
}

#[tauri::command]
pub fn model_download_cancel(
    state: State<'_, DownloadRegistry>,
    model_id: String,
) -> Result<(), String> {
    if state.cancel(&model_id) {
        log::info!("[registry] cancelling download of {model_id}");
        Ok(())
    } else {
        Err(format!("no active download for {model_id}"))
    }
}

/// Delete an installed model, refusing while a running pipeline or warm engine
/// slot holds it open (spec §2.5).
#[tauri::command]
pub fn model_delete(
    speech: State<'_, SpeechState>,
    task: String,
    model_id: String,
) -> Result<(), String> {
    registry::download::validate_path_component(&task)?;
    registry::download::validate_path_component(&model_id)?;
    let model_dir = registry::models_dir()?.join(&task).join(&model_id);
    if speech.model_in_use(&model_dir) {
        return Err(format!(
            "{task}/{model_id} is in use by a running pipeline or loaded engine — stop it first"
        ));
    }
    registry::download::delete_model(&registry::models_dir()?, &task, &model_id)?;
    log::info!("[registry] deleted {task}/{model_id}");
    Ok(())
}

/// Import a local folder as a custom model: copy it into the models store,
/// prove it loads for `task`, and mark it `custom` (spec §2.5). Rolls back the
/// copy if validation fails, so a bad folder leaves nothing behind.
#[tauri::command]
pub fn model_add_custom(
    task: String,
    name: String,
    family: Option<String>,
    source_path: String,
) -> Result<InstalledModel, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("model name is required".into());
    }
    let source = PathBuf::from(&source_path);
    if !source.is_dir() {
        return Err(format!("not a folder: {source_path}"));
    }

    let id = registry::download::slugify_custom_id(&name);
    registry::download::validate_path_component(&task)?;
    registry::download::validate_path_component(&id)?;

    let dest = registry::models_dir()?.join(&task).join(&id);
    if dest.exists() {
        return Err(format!("a custom model named \"{name}\" already exists"));
    }

    registry::download::copy_dir_into(&source, &dest)?;
    if let Err(e) = validate_model_load(&task, &dest) {
        let _ = std::fs::remove_dir_all(&dest);
        return Err(format!("model failed to load as {task}: {e}"));
    }

    let marker = CustomMarker {
        name: name.clone(),
        family,
    };
    let marker_json = serde_json::to_string_pretty(&marker).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::write(dest.join(registry::download::CUSTOM_MARKER), marker_json) {
        let _ = std::fs::remove_dir_all(&dest);
        return Err(format!("failed to write custom marker: {e}"));
    }

    log::info!("[registry] added custom model {task}/{id}");
    Ok(InstalledModel {
        task,
        id,
        size_bytes: registry::download::dir_size(&dest),
        custom: true,
        name: Some(name),
    })
}
