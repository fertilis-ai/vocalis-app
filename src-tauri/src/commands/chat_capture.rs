use tauri::ipc::Channel;
use tauri::State;

use crate::commands::speech::{resolve_model_dir, resolve_vad_path, vad_params};
use crate::pipeline::{
    start_chat_capture_pipeline, ChatCapturePipelineModels, PipelineEvent,
};
use crate::state::SpeechState;

const ASR_THREADS: i32 = 2;

fn resolve_chat_capture_models(
    asr_model: Option<String>,
    vad_model: Option<String>,
    input_device: Option<String>,
    min_silence: Option<f32>,
) -> Result<ChatCapturePipelineModels, String> {
    Ok(ChatCapturePipelineModels {
        asr_dir: resolve_model_dir("asr-batch", asr_model, "batch ASR")?,
        vad_path: resolve_vad_path(vad_model)?,
        vad_params: vad_params(None, min_silence, None),
        num_threads: ASR_THREADS,
        input_device,
    })
}

/// Start the continuous voice-chat capture pipeline (spec M4 item 3). One
/// active capture at a time; the id stays valid across multiple conversation
/// turns until `chat_capture_stop`.
#[tauri::command]
pub fn chat_capture_start(
    state: State<'_, SpeechState>,
    channel: Channel<PipelineEvent>,
    asr_model: Option<String>,
    vad_model: Option<String>,
    input_device: Option<String>,
    min_silence: Option<f32>,
) -> Result<u32, String> {
    let models = resolve_chat_capture_models(asr_model, vad_model, input_device, min_silence)?;
    let id = start_chat_capture_pipeline(&state.chat_captures, models, channel)?;
    log::info!("[chat_capture] started pipeline {id}");
    Ok(id)
}

#[tauri::command]
pub fn chat_capture_stop(state: State<'_, SpeechState>, id: u32) -> Result<(), String> {
    state.chat_captures.stop(id);
    log::info!("[chat_capture] stopped pipeline {id}");
    Ok(())
}

/// Pause (true) or resume (false) mic capture into VAD/ASR while TTS plays —
/// echo mitigation v1 (spec §3.2/§7.4). The webview calls this from the
/// playback queue's play/stop hooks.
#[tauri::command]
pub fn chat_capture_set_playback(
    state: State<'_, SpeechState>,
    id: u32,
    active: bool,
) -> Result<(), String> {
    state.chat_captures.set_playback_active(id, active)
}

/// Push-to-talk: force-finalize the in-progress utterance on key-release,
/// without waiting for a VAD/ASR endpoint.
#[tauri::command]
pub fn chat_capture_force_finalize(state: State<'_, SpeechState>, id: u32) -> Result<(), String> {
    state.chat_captures.force_finalize(id)
}
