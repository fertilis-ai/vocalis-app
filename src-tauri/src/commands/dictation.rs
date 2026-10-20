use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::engines::Punctuator;
use crate::pipeline::{start_dictation_pipeline, DictationPipelineModels, PipelineEvent};
use crate::registry;
use crate::state::SpeechState;

const ASR_THREADS: i32 = 2;
const PUNCTUATION_THREADS: i32 = 2;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct HotkeyEvent {
    state: &'static str,
    mode: &'static str,
}

fn show_hud(app: &AppHandle) {
    if let Some(hud) = app.get_webview_window("hud") {
        let _ = hud.show();
    }
}

/// Stop every active dictation and hide the HUD. Used by the tray emergency
/// action as well as available to the webview for recovery UI.
pub fn force_stop_dictation(app: &AppHandle) {
    app.state::<SpeechState>().dictations.cancel_all();
    if let Some(hud) = app.get_webview_window("hud") {
        let _ = hud.hide();
    }
}

/// Register the one system-wide dictation shortcut. Its handler deliberately
/// only wakes the already-loaded HUD webview: that surface opens the channel
/// to the pipeline, preserving the normal serialized PipelineEvent bridge.
pub fn configure_hotkey(app: &AppHandle, hotkey: &str, mode: &str) -> Result<(), String> {
    if !matches!(mode, "hold" | "toggle") {
        return Err("dictation mode must be 'hold' or 'toggle'".into());
    }
    let shortcuts = app.global_shortcut();
    shortcuts
        .unregister_all()
        .map_err(|error| format!("failed to clear previous hotkey: {error}"))?;

    let mode = if mode == "toggle" { "toggle" } else { "hold" };
    shortcuts
        .on_shortcut(hotkey, move |app, _, event| {
            if mode == "toggle" && event.state == ShortcutState::Released {
                return;
            }
            if event.state == ShortcutState::Pressed {
                show_hud(app);
            }
            let state = match event.state {
                ShortcutState::Pressed => "pressed",
                ShortcutState::Released => "released",
            };
            let _ = app.emit("dictation-hotkey", HotkeyEvent { state, mode });
        })
        .map_err(|error| format!("failed to register '{hotkey}': {error}"))?;

    // This is deliberately native rather than HUD-mediated: it remains able
    // to stop capture even if a webview fails or the HUD is non-focusable.
    shortcuts
        .on_shortcut("Alt+Escape", |app, _, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            force_stop_dictation(app);
            let _ = app.emit(
                "dictation-hotkey",
                HotkeyEvent {
                    state: "cancel",
                    mode: "hold",
                },
            );
        })
        .map_err(|error| format!("failed to register emergency cancel: {error}"))?;

    log::info!("[dictation] registered global hotkey {hotkey} ({mode})");
    Ok(())
}

#[tauri::command]
pub fn dictation_configure_hotkey(
    app: AppHandle,
    hotkey: String,
    mode: String,
) -> Result<(), String> {
    configure_hotkey(&app, &hotkey, &mode)
}

#[tauri::command]
pub fn dictation_force_stop(app: AppHandle) {
    force_stop_dictation(&app);
    log::info!("[dictation] force-stopped active pipelines");
}

fn resolve_dictation_models(
    asr_model: Option<String>,
    vad_model: Option<String>,
    input_device: Option<String>,
) -> Result<DictationPipelineModels, String> {
    let asr_dir = match asr_model {
        Some(id) => registry::resolve("asr-batch", &id)?,
        None => registry::first_installed("asr-batch")?,
    }
    .ok_or("no batch ASR model installed — download one in Models")?;
    let vad_dir = match vad_model {
        Some(id) => registry::resolve("vad", &id)?,
        None => registry::first_installed("vad")?,
    }
    .ok_or("no VAD model installed — download one in Models")?;
    let vad_path = registry::find_file(&vad_dir, "silero", ".onnx")
        .ok_or_else(|| format!("no silero .onnx in {}", vad_dir.display()))?;

    Ok(DictationPipelineModels {
        asr_dir,
        vad_path,
        num_threads: ASR_THREADS,
        input_device,
    })
}

#[tauri::command]
pub fn dictation_start(
    state: State<'_, SpeechState>,
    channel: Channel<PipelineEvent>,
    asr_model: Option<String>,
    vad_model: Option<String>,
    input_device: Option<String>,
) -> Result<u32, String> {
    let models = resolve_dictation_models(asr_model, vad_model, input_device)?;
    let id = start_dictation_pipeline(&state.dictations, models, channel)?;
    log::info!("[dictation] started pipeline {id}");
    Ok(id)
}

/// Stop capture, flush the in-progress ASR utterance, and restore punctuation.
/// A missing or failed punctuation model returns raw text instead of discarding
/// a user's dictation.
#[tauri::command]
pub fn dictation_finalize(
    state: State<'_, SpeechState>,
    id: u32,
    punctuation_model: Option<String>,
) -> Result<String, String> {
    let raw = state.dictations.finalize(id)?;
    if raw.trim().is_empty() {
        return Ok(raw);
    }

    let mut guard = state.punctuator.lock().unwrap();
    if guard.is_none() {
        let model_dir = match punctuation_model {
            Some(model) => registry::resolve("punctuation", &model),
            None => registry::first_installed("punctuation"),
        };
        match model_dir {
            Ok(Some(dir)) => match Punctuator::new(&dir, PUNCTUATION_THREADS) {
                Ok(engine) => {
                    log::info!("[dictation] loaded punctuation model {}", dir.display());
                    *guard = Some(crate::state::PunctuatorSlot {
                        engine,
                        model_dir: dir,
                    });
                }
                Err(error) => log::warn!("[dictation] punctuation unavailable: {error}"),
            },
            Ok(None) => log::warn!("[dictation] no punctuation model installed; using raw text"),
            Err(error) => log::warn!("[dictation] could not resolve punctuation model: {error}"),
        }
    }

    Ok(guard
        .as_ref()
        .map(|slot| slot.engine.punctuate_if_needed(&raw))
        .unwrap_or(raw))
}

#[tauri::command]
pub fn dictation_cancel(state: State<'_, SpeechState>, id: u32) -> Result<(), String> {
    state.dictations.cancel(id)?;
    log::info!("[dictation] cancelled pipeline {id}");
    Ok(())
}
