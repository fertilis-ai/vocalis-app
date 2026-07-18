use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::audio::{list_input_devices, InputDeviceInfo, TARGET_SAMPLE_RATE};
use crate::commands::app_data_dir;
use crate::engines::{
    cosine_similarity, detect_speech_spans, spot_keywords_in_clip, CloneTtsEngine,
    DiarizationParams, DiarizationSegment, Diarizer, KeywordHit, LangIdentifier, OfflineAsr,
    Punctuator, SourceSeparator, SpeakerEmbedder, SpeechSpan, StreamingAsrSession, TtsEngine,
    VadParams, WordSpan, CLONE_TTS_DEFAULT_STEPS,
};
use crate::pipeline::{
    start_asr_pipeline, start_import, start_kws_pipeline, start_recorder, start_session_pipeline,
    AsrPipelineModels, ImportModels, KwsPipelineModels, PipelineEvent, RecorderEvent,
    SessionPipelineModels,
};
use crate::registry;
use crate::state::{
    CloneTtsSlot, DiarizerSlot, LangIdSlot, OfflineAsrSlot, SeparatorSlot, SpeakerSlot,
    SpeechState, TtsSlot,
};

/// Threads per engine on Apple Silicon: enough for realtime, leaves headroom
/// for concurrent VAD/TTS (tunable via settings later — spike §risks.3).
const ASR_THREADS: i32 = 2;
const TTS_THREADS: i32 = 4;
const PUNCTUATION_THREADS: i32 = 2;
/// Batch transcription is a foreground one-shot — use more cores than the
/// realtime engines, which must leave headroom for each other.
const BATCH_ASR_THREADS: i32 = 4;
const SPEAKER_THREADS: i32 = 2;
/// Diarization is a foreground one-shot like batch ASR.
const DIARIZE_THREADS: i32 = 4;
/// KWS is a light streaming model (3.3M params) — realtime-sized.
const KWS_THREADS: i32 = 2;
/// Language ID and source separation are foreground one-shots.
const LANGID_THREADS: i32 = 4;
const SEPARATION_THREADS: i32 = 4;

/// Spec §3.4 fallback chain for local models: explicit id → first installed.
pub(crate) fn resolve_model_dir(
    task: &str,
    model: Option<String>,
    hint: &str,
) -> Result<PathBuf, String> {
    match model {
        Some(id) => registry::resolve(task, &id)?,
        None => registry::first_installed(task)?,
    }
    .ok_or_else(|| format!("no {hint} model installed — download one in Models"))
}

pub(crate) fn resolve_vad_path(vad_model: Option<String>) -> Result<PathBuf, String> {
    let vad_dir = match vad_model {
        Some(id) => registry::resolve("vad", &id)?,
        None => registry::first_installed("vad")?,
    }
    .ok_or("no VAD model installed — download one in Models")?;
    registry::find_file(&vad_dir, "silero", ".onnx")
        .ok_or_else(|| format!("no silero .onnx in {}", vad_dir.display()))
}

pub(crate) fn vad_params(
    threshold: Option<f32>,
    min_silence: Option<f32>,
    min_speech: Option<f32>,
) -> VadParams {
    let defaults = VadParams::default();
    VadParams {
        threshold: threshold.unwrap_or(defaults.threshold),
        min_silence: min_silence.unwrap_or(defaults.min_silence),
        min_speech: min_speech.unwrap_or(defaults.min_speech),
    }
}

#[tauri::command]
pub fn audio_input_devices() -> Result<Vec<InputDeviceInfo>, String> {
    list_input_devices()
}

#[tauri::command]
pub fn asr_pipeline_start(
    state: State<'_, SpeechState>,
    channel: Channel<PipelineEvent>,
    asr_model: Option<String>,
    vad_model: Option<String>,
    input_device: Option<String>,
) -> Result<u32, String> {
    let asr_dir = match asr_model {
        Some(id) => registry::resolve("asr-streaming", &id)?,
        None => registry::first_installed("asr-streaming")?,
    }
    .ok_or("no streaming ASR model installed — download one in Models")?;

    let id = start_asr_pipeline(
        &state.pipelines,
        AsrPipelineModels {
            asr_dir: Some(asr_dir),
            vad_path: resolve_vad_path(vad_model)?,
            vad_params: VadParams::default(),
            num_threads: ASR_THREADS,
            input_device,
        },
        channel,
    );
    log::info!("[speech] started asr pipeline {id}");
    Ok(id)
}

/// Live mic → VAD-only pipeline for the playground VAD tool. Emits VadState
/// and Level events; stopped through the same asr_pipeline_stop registry.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn vad_pipeline_start(
    state: State<'_, SpeechState>,
    channel: Channel<PipelineEvent>,
    vad_model: Option<String>,
    input_device: Option<String>,
    threshold: Option<f32>,
    min_silence: Option<f32>,
    min_speech: Option<f32>,
) -> Result<u32, String> {
    let id = start_asr_pipeline(
        &state.pipelines,
        AsrPipelineModels {
            asr_dir: None,
            vad_path: resolve_vad_path(vad_model)?,
            vad_params: vad_params(threshold, min_silence, min_speech),
            num_threads: ASR_THREADS,
            input_device,
        },
        channel,
    );
    log::info!("[speech] started vad pipeline {id}");
    Ok(id)
}

#[tauri::command]
pub fn asr_pipeline_stop(state: State<'_, SpeechState>, id: u32) -> Result<(), String> {
    if state.pipelines.stop(id) {
        log::info!("[speech] stopping asr pipeline {id}");
        Ok(())
    } else {
        Err(format!("no running pipeline with id {id}"))
    }
}

/// Online provisional labeling threshold (join a running cluster) — spec §7.3.
const SESSION_CLUSTER_THRESHOLD: f32 = 0.5;
/// Enrolled-Person match threshold (spec §3.5 default).
const SESSION_MATCH_THRESHOLD: f32 = 0.55;

/// Start a live transcription session: mic → VAD → batch ASR per utterance →
/// punctuation → online provisional speaker labeling, retaining the audio for a stop-time
/// diarization refinement pass. Returns the pipeline id immediately; turns and
/// the settled transcript arrive as events. Only one session runs at a time.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn session_pipeline_start(
    state: State<'_, SpeechState>,
    channel: Channel<PipelineEvent>,
    session_id: String,
    audio_retained: bool,
    asr_model: Option<String>,
    vad_model: Option<String>,
    punctuation_model: Option<String>,
    speaker_model: Option<String>,
    diarization_model: Option<String>,
    input_device: Option<String>,
    // Enrolled people to match live turns + refined clusters against (M3 item 3).
    enrolled: Vec<crate::commands::people::EnrolledPersonRef>,
    // Prior transcript segments, when resuming a non-draft session (empty for a
    // fresh session) — seeds speaker-cluster + audio continuity across a pause.
    resume_segments: Vec<crate::pipeline::ResumeSegment>,
) -> Result<u32, String> {
    registry::download::validate_path_component(&session_id)?;
    if state.session_active.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("a transcription session is already running".into());
    }
    // Resolve every model up front; on any failure, release the guard so the
    // next attempt isn't wrongly blocked.
    let resolved = (|| -> Result<SessionPipelineModels, String> {
        let speaker_dir = resolve_model_dir("speaker-embedding", speaker_model, "speaker embedding")?;
        let enrolled = crate::commands::people::load_enrolled(enrolled);
        Ok(SessionPipelineModels {
            asr_dir: resolve_model_dir("asr-batch", asr_model, "batch ASR")?,
            vad_path: resolve_vad_path(vad_model)?,
            punctuation_dir: resolve_model_dir("punctuation", punctuation_model, "punctuation")?,
            diar_segmentation_dir: resolve_model_dir("diarization", diarization_model, "diarization")?,
            diar_embedding_dir: speaker_dir.clone(),
            speaker_dir,
            num_threads: ASR_THREADS,
            input_device,
            session_dir: app_data_dir()?.join("sessions").join(&session_id),
            audio_retained,
            enrolled,
            cluster_threshold: SESSION_CLUSTER_THRESHOLD,
            match_threshold: SESSION_MATCH_THRESHOLD,
            resume_segments,
        })
    })();
    let models = match resolved {
        Ok(m) => m,
        Err(e) => {
            state
                .session_active
                .store(false, std::sync::atomic::Ordering::SeqCst);
            return Err(e);
        }
    };

    let id = start_session_pipeline(
        &state.pipelines,
        state.session_active.clone(),
        models,
        channel,
    );
    log::info!("[speech] started session pipeline {id} for {session_id}");
    Ok(id)
}

/// Stop a live session, triggering the refinement pass. The settled transcript
/// arrives as a `Refined` event, then `Stopped`.
#[tauri::command]
pub fn session_pipeline_stop(state: State<'_, SpeechState>, id: u32) -> Result<(), String> {
    if state.pipelines.stop(id) {
        log::info!("[speech] stopping session pipeline {id}");
        Ok(())
    } else {
        Err(format!("no running session pipeline with id {id}"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAudioResult {
    /// The normalized 16 kHz mono wav path (also the session's retained audio).
    pub audio_path: String,
    pub duration_ms: f64,
}

/// Decode an arbitrary audio file (wav/mp3/m4a/flac) to 16 kHz mono and write it
/// as `sessions/<id>/audio.wav` — the normalized input consumed by both the
/// local import run and the API import path, and the session's retained audio
/// for the scrubber. The original file is left untouched (spec §4).
#[tauri::command]
pub fn import_audio(session_id: String, path: String) -> Result<ImportAudioResult, String> {
    registry::download::validate_path_component(&session_id)?;
    let samples = crate::audio::decode_to_16k_mono(std::path::Path::new(&path))?;
    let duration_ms = samples.len() as f64 * 1000.0 / TARGET_SAMPLE_RATE as f64;

    let session_dir = app_data_dir()?.join("sessions").join(&session_id);
    std::fs::create_dir_all(&session_dir).map_err(|e| e.to_string())?;
    let out = session_dir.join("audio.wav");
    let out_str = out.to_string_lossy().into_owned();
    if !sherpa_onnx::write(&out_str, &samples, TARGET_SAMPLE_RATE as i32) {
        return Err(format!("failed to write normalized audio to {out_str}"));
    }
    log::info!("[speech] normalized import {path} → {out_str} ({duration_ms:.0}ms)");
    Ok(ImportAudioResult {
        audio_path: out_str,
        duration_ms,
    })
}

/// Run a local batch import over `sessions/<id>/audio.wav` (written first by
/// `import_audio`): diarize → per-span batch ASR → punctuation → enrolled-Person
/// matching. Streams `SpeakerTurn`/`Progress` events and a settled `Refined` +
/// `Stopped`, exactly like the live session pipeline. One session at a time.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn session_import(
    state: State<'_, SpeechState>,
    channel: Channel<PipelineEvent>,
    session_id: String,
    asr_model: Option<String>,
    punctuation_model: Option<String>,
    speaker_model: Option<String>,
    diarization_model: Option<String>,
    language: Option<String>,
    enrolled: Vec<crate::commands::people::EnrolledPersonRef>,
) -> Result<u32, String> {
    registry::download::validate_path_component(&session_id)?;
    if state.session_active.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("a transcription session is already running".into());
    }
    let resolved = (|| -> Result<ImportModels, String> {
        let speaker_dir = resolve_model_dir("speaker-embedding", speaker_model, "speaker embedding")?;
        let enrolled = crate::commands::people::load_enrolled(enrolled);
        // Normalize "auto"/empty to whisper auto-detect (matches the bench).
        let language = language.filter(|lang| !lang.is_empty() && lang != "auto");
        Ok(ImportModels {
            asr_dir: resolve_model_dir("asr-batch", asr_model, "batch ASR")?,
            punctuation_dir: resolve_model_dir("punctuation", punctuation_model, "punctuation")?,
            diar_segmentation_dir: resolve_model_dir("diarization", diarization_model, "diarization")?,
            diar_embedding_dir: speaker_dir.clone(),
            speaker_dir,
            num_threads: BATCH_ASR_THREADS,
            session_dir: app_data_dir()?.join("sessions").join(&session_id),
            language,
            enrolled,
            match_threshold: SESSION_MATCH_THRESHOLD,
        })
    })();
    let models = match resolved {
        Ok(m) => m,
        Err(e) => {
            state
                .session_active
                .store(false, std::sync::atomic::Ordering::SeqCst);
            return Err(e);
        }
    };

    let id = start_import(&state.pipelines, state.session_active.clone(), models, channel);
    log::info!("[speech] started import {id} for {session_id}");
    Ok(id)
}

/// Cancel a running import (registry stop flag); the thread emits `Stopped`.
#[tauri::command]
pub fn session_import_cancel(state: State<'_, SpeechState>, id: u32) -> Result<(), String> {
    if state.pipelines.stop(id) {
        log::info!("[speech] cancelling import {id}");
        Ok(())
    } else {
        Err(format!("no running import with id {id}"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsResult {
    pub path: String,
    pub duration_secs: f64,
    pub cached: bool,
}

/// Default TTS cache cap when the webview doesn't pass one (config default 2 GB).
const TTS_CACHE_DEFAULT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[tauri::command]
pub fn tts_synthesize(
    state: State<'_, SpeechState>,
    text: String,
    speaker_id: Option<i32>,
    speed: Option<f32>,
    model: Option<String>,
    max_cache_bytes: Option<u64>,
) -> Result<TtsResult, String> {
    let sid = speaker_id.unwrap_or(0);
    let speed = speed.unwrap_or(1.0);

    // Resolve the model dir first so its id can key the cache — otherwise two
    // models producing the same text+voice+speed would collide on one wav.
    let model_dir = match &model {
        Some(id) => registry::resolve("tts", id)?,
        None => registry::first_installed("tts")?,
    }
    .ok_or("no TTS model installed — download one in Models")?;
    let model_tag = model_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("tts");

    let cache_dir = app_data_dir()?.join("cache/tts");
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    // Content-addressed cache: same model+text+voice+speed replays the same wav.
    let mut hasher = DefaultHasher::new();
    (model_tag, &text, sid, speed.to_bits()).hash(&mut hasher);
    let out_path = cache_dir.join(format!("{model_tag}-{:016x}.wav", hasher.finish()));

    if out_path.exists() {
        // Bump mtime so a replayed cache hit isn't evicted as if it were
        // untouched since its original synthesis.
        if let Ok(file) = std::fs::OpenOptions::new().write(true).open(&out_path) {
            let _ = file.set_modified(SystemTime::now());
        }
        return Ok(TtsResult {
            path: out_path.to_string_lossy().into_owned(),
            duration_secs: 0.0,
            cached: true,
        });
    }

    let mut guard = state.tts.lock().unwrap();
    let needs_reload = guard.as_ref().map(|s| s.model_dir != model_dir).unwrap_or(true);
    if needs_reload {
        log::info!("[speech] loading tts from {}", model_dir.display());
        *guard = Some(TtsSlot {
            engine: TtsEngine::new(&model_dir, TTS_THREADS)?,
            model_dir: model_dir.clone(),
        });
    }
    let tts = &guard.as_ref().unwrap().engine;

    let duration_secs = tts.synthesize_to_wav(&text, sid, speed, &out_path)?;
    drop(guard);

    // LRU eviction: keep the cache under the cap by deleting oldest-mtime wavs.
    let cap = max_cache_bytes.unwrap_or(TTS_CACHE_DEFAULT_BYTES);
    if let Err(e) = evict_tts_cache(&cache_dir, cap) {
        log::warn!("[speech] tts cache eviction failed: {e}");
    }

    Ok(TtsResult {
        path: out_path.to_string_lossy().into_owned(),
        duration_secs,
        cached: false,
    })
}

/// ZipVoice thread budget: the spike hit 0.8 s TTFA at 8 threads on 12 cores
/// (RTF 1.24 single-threaded), so throughput matters more here than for the
/// light stock-TTS engines — but VAD/ASR must keep headroom in a live chat.
fn clone_tts_default_threads() -> i32 {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(8);
    (cores - 4).clamp(4, 8)
}

/// Load (or reload) the clone-TTS engine into its slot; returns load time in
/// ms, 0.0 when it was already warm with the same model + thread count.
fn ensure_clone_tts(
    guard: &mut Option<CloneTtsSlot>,
    model_dir: PathBuf,
    num_threads: i32,
) -> Result<f64, String> {
    let warm = matches!(
        guard.as_ref(),
        Some(s) if s.model_dir == model_dir && s.num_threads == num_threads
    );
    if warm {
        return Ok(0.0);
    }
    log::info!(
        "[speech] loading clone-tts from {} ({num_threads} threads)",
        model_dir.display()
    );
    let started = std::time::Instant::now();
    let engine = CloneTtsEngine::new(&model_dir, num_threads)?;
    let load_ms = started.elapsed().as_secs_f64() * 1000.0;
    *guard = Some(CloneTtsSlot {
        model_dir,
        num_threads,
        engine,
    });
    Ok(load_ms)
}

/// Pre-load the ZipVoice engine (the spec §3.3 "warming up" surface): the
/// webview calls this on conversation open when the conversation's voice is a
/// local clone, showing its own warming state while it awaits. Returns load ms.
#[tauri::command]
pub fn clone_tts_warm(
    state: State<'_, SpeechState>,
    model: Option<String>,
    num_threads: Option<i32>,
) -> Result<f64, String> {
    let model_dir = resolve_model_dir("clone-tts", model, "voice cloning")?;
    let threads = num_threads.unwrap_or_else(clone_tts_default_threads);
    let mut guard = state.clone_tts.lock().unwrap();
    ensure_clone_tts(&mut guard, model_dir, threads)
}

/// Drop the warm ZipVoice engine (~600 MB resident) — the EngineManager
/// eviction hook (spec §7.7). Returns true if an engine was actually unloaded.
#[tauri::command]
pub fn clone_tts_unload(state: State<'_, SpeechState>) -> Result<bool, String> {
    let unloaded = state.clone_tts.lock().unwrap().take().is_some();
    if unloaded {
        log::info!("[speech] unloaded clone-tts engine");
    }
    Ok(unloaded)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneTtsResult {
    pub path: String,
    pub duration_secs: f64,
    pub cached: bool,
    /// Engine load time when this call had to (re)load ZipVoice, else 0 —
    /// lets the webview log warm-up separately from synthesis in Metrics.
    pub engine_load_ms: f64,
    pub synth_ms: f64,
}

/// Clone-voice synthesis (M5 item 2): ZipVoice conditioned on a reference
/// clip + its transcript. Output wavs share the stock-TTS cache dir and LRU
/// cap. A failing synth is an error — never a silent reroute to an API engine
/// (spec §3.4).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn clone_tts_synthesize(
    state: State<'_, SpeechState>,
    text: String,
    ref_audio: String,
    ref_text: String,
    model: Option<String>,
    speed: Option<f32>,
    num_steps: Option<i32>,
    num_threads: Option<i32>,
    max_cache_bytes: Option<u64>,
) -> Result<CloneTtsResult, String> {
    let speed = speed.unwrap_or(1.0);
    let steps = num_steps.unwrap_or(CLONE_TTS_DEFAULT_STEPS);
    let threads = num_threads.unwrap_or_else(clone_tts_default_threads);
    // The webview references clone clips as ~/.vocalis/people/… paths.
    let ref_audio = crate::commands::expand_tilde(&ref_audio);

    let model_dir = resolve_model_dir("clone-tts", model, "voice cloning")?;
    let model_tag = model_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("clone-tts");

    let cache_dir = app_data_dir()?.join("cache/tts");
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    // Content-addressed like tts_synthesize, but the voice is the reference
    // clip: key on its mtime + size too, so re-recording a clone reference at
    // the same path never replays the old voice.
    let ref_meta = std::fs::metadata(&ref_audio)
        .map_err(|e| format!("reference audio {ref_audio}: {e}"))?;
    let ref_stamp = ref_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut hasher = DefaultHasher::new();
    (
        model_tag,
        &text,
        &ref_audio,
        ref_stamp,
        ref_meta.len(),
        &ref_text,
        speed.to_bits(),
        steps,
    )
        .hash(&mut hasher);
    let out_path = cache_dir.join(format!("{model_tag}-{:016x}.wav", hasher.finish()));

    if out_path.exists() {
        if let Ok(file) = std::fs::OpenOptions::new().write(true).open(&out_path) {
            let _ = file.set_modified(SystemTime::now());
        }
        return Ok(CloneTtsResult {
            path: out_path.to_string_lossy().into_owned(),
            duration_secs: 0.0,
            cached: true,
            engine_load_ms: 0.0,
            synth_ms: 0.0,
        });
    }

    let ref_samples = read_wav_16k(&ref_audio)?;

    let mut guard = state.clone_tts.lock().unwrap();
    let engine_load_ms = ensure_clone_tts(&mut guard, model_dir, threads)?;
    let engine = &guard.as_ref().unwrap().engine;

    let started = std::time::Instant::now();
    let duration_secs = engine.synthesize_to_wav(
        &text,
        &ref_samples,
        TARGET_SAMPLE_RATE as i32,
        &ref_text,
        speed,
        steps,
        &out_path,
    )?;
    let synth_ms = started.elapsed().as_secs_f64() * 1000.0;
    drop(guard);
    log::info!(
        "[speech] clone-tts synthesized {duration_secs:.2}s in {synth_ms:.0}ms \
         (load {engine_load_ms:.0}ms, rtf {:.2})",
        synth_ms / 1000.0 / duration_secs.max(0.001)
    );

    let cap = max_cache_bytes.unwrap_or(TTS_CACHE_DEFAULT_BYTES);
    if let Err(e) = evict_tts_cache(&cache_dir, cap) {
        log::warn!("[speech] tts cache eviction failed: {e}");
    }

    Ok(CloneTtsResult {
        path: out_path.to_string_lossy().into_owned(),
        duration_secs,
        cached: false,
        engine_load_ms,
        synth_ms,
    })
}

/// Sum the sizes of the wavs in the TTS cache dir (0 if it doesn't exist).
fn tts_cache_bytes(cache_dir: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return 0;
    };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

/// Delete oldest-mtime wavs until the cache fits under `max_bytes`.
fn evict_tts_cache(cache_dir: &std::path::Path, max_bytes: u64) -> Result<(), String> {
    let mut files: Vec<(std::path::PathBuf, SystemTime, u64)> = std::fs::read_dir(cache_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
            Some((e.path(), mtime, meta.len()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|(_, _, len)| *len).sum();
    if total <= max_bytes {
        return Ok(());
    }
    // Oldest first, so the least-recently-written wavs go first.
    files.sort_by_key(|(_, mtime, _)| *mtime);
    for (path, _, len) in files {
        if total <= max_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
            log::info!("[speech] evicted tts cache wav {}", path.display());
        }
    }
    Ok(())
}

/// Current TTS cache size in bytes — feeds the Models & Storage meter.
#[tauri::command]
pub fn tts_cache_size() -> Result<u64, String> {
    Ok(tts_cache_bytes(&app_data_dir()?.join("cache/tts")))
}

/// Evict the TTS cache down to `max_cache_bytes`. The local `tts_synthesize`
/// path evicts after every local synth; API adapters write into the same
/// cache dir directly (spec §3.4's TS↔Rust boundary) and need this exposed
/// so they stay under the cap too.
#[tauri::command]
pub fn tts_cache_evict(max_cache_bytes: Option<u64>) -> Result<(), String> {
    let cache_dir = app_data_dir()?.join("cache/tts");
    let cap = max_cache_bytes.unwrap_or(TTS_CACHE_DEFAULT_BYTES);
    evict_tts_cache(&cache_dir, cap)
}

/// Copy a synthesized wav into the bench recording library so it shows up in
/// the input picker's Library tab. Returns the new path.
#[tauri::command]
pub fn tts_save_to_library(path: String, label: Option<String>) -> Result<String, String> {
    let src = std::path::PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("no such file: {path}"));
    }
    let dir = app_data_dir()?.join("recordings/bench");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let slug = label
        .as_deref()
        .map(sanitize_slug)
        .filter(|s| !s.is_empty())
        .map(|s| format!("-{s}"))
        .unwrap_or_default();
    let dest = dir.join(format!("tts-{stamp}{slug}.wav"));
    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Reduce a label to a short filesystem-safe slug.
fn sanitize_slug(label: &str) -> String {
    label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .split('-')
        .filter(|s| !s.is_empty())
        .take(6)
        .collect::<Vec<_>>()
        .join("-")
}

/// Record a bench clip from the mic into ~/.vocalis/recordings/bench/.
/// Returns the recorder id immediately; the saved path arrives as a
/// RecorderEvent::Saved on the channel.
#[tauri::command]
pub fn record_start(
    state: State<'_, SpeechState>,
    channel: Channel<RecorderEvent>,
    input_device: Option<String>,
) -> Result<u32, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let out_path = app_data_dir()?
        .join("recordings/bench")
        .join(format!("rec-{millis}.wav"));

    let id = start_recorder(&state.recorders, out_path, input_device, channel);
    log::info!("[speech] started recorder {id}");
    Ok(id)
}

#[tauri::command]
pub fn record_stop(state: State<'_, SpeechState>, id: u32) -> Result<(), String> {
    if state.recorders.stop(id) {
        Ok(())
    } else {
        Err(format!("no running recorder with id {id}"))
    }
}

#[tauri::command]
pub fn record_cancel(state: State<'_, SpeechState>, id: u32) -> Result<(), String> {
    if state.recorders.cancel(id) {
        Ok(())
    } else {
        Err(format!("no running recorder with id {id}"))
    }
}

/// Load an audio file (wav/mp3/m4a/flac) as 16 kHz mono f32 for bench inputs.
pub(crate) fn read_wav_16k(path: &str) -> Result<Vec<f32>, String> {
    crate::audio::decode_to_16k_mono(std::path::Path::new(path))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VadAnalysis {
    pub duration_secs: f64,
    pub segments: Vec<SpeechSpan>,
}

/// Offline VAD over a wav file — the playground VAD tool's file mode.
#[tauri::command]
pub fn vad_analyze_file(
    path: String,
    vad_model: Option<String>,
    threshold: Option<f32>,
    min_silence: Option<f32>,
    min_speech: Option<f32>,
) -> Result<VadAnalysis, String> {
    let vad_path = resolve_vad_path(vad_model)?;
    let samples = read_wav_16k(&path)?;
    let duration_secs = samples.len() as f64 / TARGET_SAMPLE_RATE as f64;
    let segments = detect_speech_spans(
        &vad_path,
        &samples,
        vad_params(threshold, min_silence, min_speech),
    )?;
    log::info!(
        "[speech] vad analyzed {path}: {} segments over {duration_secs:.1}s",
        segments.len()
    );
    Ok(VadAnalysis {
        duration_secs,
        segments,
    })
}

/// Punctuate arbitrary text — the playground punctuation tool. Unlike
/// dictation (which falls back to raw text), a missing model is an error the
/// bench surfaces.
#[tauri::command]
pub fn punctuate_text(
    state: State<'_, SpeechState>,
    text: String,
    model: Option<String>,
) -> Result<String, String> {
    let mut guard = state.punctuator.lock().unwrap();
    if guard.is_none() {
        let model_dir = match model {
            Some(id) => registry::resolve("punctuation", &id)?,
            None => registry::first_installed("punctuation")?,
        }
        .ok_or("no punctuation model installed — download one in Models")?;
        log::info!("[speech] loading punctuation from {}", model_dir.display());
        *guard = Some(crate::state::PunctuatorSlot {
            engine: Punctuator::new(&model_dir, PUNCTUATION_THREADS)?,
            model_dir,
        });
    }
    Ok(guard.as_ref().unwrap().engine.punctuate(&text))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFileInfo {
    pub duration_secs: f64,
    pub sample_rate: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeFileResult {
    pub text: String,
    pub words: Vec<WordSpan>,
    pub duration_secs: f64,
    pub processing_ms: f64,
    /// Real-time factor: processing time / audio duration (lower is faster).
    pub rtf: f64,
}

fn timed_transcription<F>(samples: Vec<f32>, transcribe: F) -> Result<TranscribeFileResult, String>
where
    F: FnOnce(&[f32]) -> Result<crate::engines::Transcription, String>,
{
    let duration_secs = samples.len() as f64 / TARGET_SAMPLE_RATE as f64;
    let started = std::time::Instant::now();
    let transcription = transcribe(&samples)?;
    let processing_ms = started.elapsed().as_secs_f64() * 1000.0;
    Ok(TranscribeFileResult {
        text: transcription.text,
        words: transcription.words,
        duration_secs,
        processing_ms,
        rtf: processing_ms / 1000.0 / duration_secs.max(0.001),
    })
}

/// Batch-transcribe a wav with the offline Whisper engine — the ASR bench's
/// file mode (spec §2.3). `language` is a whisper code; None = auto-detect.
#[tauri::command]
pub fn asr_transcribe_file(
    state: State<'_, SpeechState>,
    path: String,
    model: Option<String>,
    language: Option<String>,
) -> Result<TranscribeFileResult, String> {
    let model_dir = match model {
        Some(id) => registry::resolve("asr-batch", &id)?,
        None => registry::first_installed("asr-batch")?,
    }
    .ok_or("no batch ASR model installed — download one in Models")?;
    // Normalize "auto" (the bench's select default) to whisper auto-detect.
    let language = language.filter(|lang| !lang.is_empty() && lang != "auto");

    let samples = read_wav_16k(&path)?;
    let mut guard = state.offline_asr.lock().unwrap();
    let stale = !matches!(
        guard.as_ref(),
        Some(slot) if slot.model_dir == model_dir && slot.language == language
    );
    if stale {
        log::info!(
            "[speech] loading batch asr from {} (language: {})",
            model_dir.display(),
            language.as_deref().unwrap_or("auto")
        );
        *guard = Some(OfflineAsrSlot {
            engine: OfflineAsr::new(&model_dir, BATCH_ASR_THREADS, language.as_deref())?,
            model_dir,
            language,
        });
    }
    let engine = &guard.as_ref().unwrap().engine;

    let result = timed_transcription(samples, |samples| engine.transcribe(samples))?;
    log::info!(
        "[speech] batch transcribed {path}: {:.1}s audio in {:.0}ms (rtf {:.2})",
        result.duration_secs,
        result.processing_ms,
        result.rtf
    );
    Ok(result)
}

/// Run the streaming Zipformer over a whole wav — the ASR bench's
/// engine-compare mode (same clip through streaming and batch engines).
#[tauri::command]
pub fn asr_transcribe_file_streaming(
    path: String,
    model: Option<String>,
) -> Result<TranscribeFileResult, String> {
    let model_dir = match model {
        Some(id) => registry::resolve("asr-streaming", &id)?,
        None => registry::first_installed("asr-streaming")?,
    }
    .ok_or("no streaming ASR model installed — download one in Models")?;

    let samples = read_wav_16k(&path)?;
    // A fresh session per run: compare is occasional, and sharing the live
    // pipelines' recognizer would couple their endpointing state to the bench.
    let session = StreamingAsrSession::new(&model_dir, BATCH_ASR_THREADS)?;
    let result = timed_transcription(samples, |samples| session.transcribe_file(samples))?;
    log::info!(
        "[speech] streaming-transcribed {path}: {:.1}s audio in {:.0}ms (rtf {:.2})",
        result.duration_secs,
        result.processing_ms,
        result.rtf
    );
    Ok(result)
}

/// Load the cached speaker embedder (reloading on model change) and run
/// `body` with it while the slot lock is held.
fn with_speaker_embedder<T>(
    state: &State<'_, SpeechState>,
    model: Option<String>,
    body: impl FnOnce(&SpeakerEmbedder) -> Result<T, String>,
) -> Result<T, String> {
    let model_dir = resolve_model_dir("speaker-embedding", model, "speaker embedding")?;
    let mut guard = state.speaker.lock().unwrap();
    if !matches!(guard.as_ref(), Some(slot) if slot.model_dir == model_dir) {
        log::info!("[speech] loading speaker embedding from {}", model_dir.display());
        *guard = Some(SpeakerSlot {
            engine: SpeakerEmbedder::new(&model_dir, SPEAKER_THREADS)?,
            model_dir,
        });
    }
    body(&guard.as_ref().unwrap().engine)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerCompareResult {
    pub similarity: f32,
    pub is_match: bool,
    pub threshold: f32,
    pub embedding_dim: usize,
    pub processing_ms: f64,
}

/// Speaker verification: are two clips the same voice? Returns the cosine
/// similarity of their embeddings and the decision at `threshold`.
#[tauri::command]
pub fn speaker_compare_files(
    state: State<'_, SpeechState>,
    path_a: String,
    path_b: String,
    model: Option<String>,
    threshold: Option<f32>,
) -> Result<SpeakerCompareResult, String> {
    let threshold = threshold.unwrap_or(0.5);
    let samples_a = read_wav_16k(&path_a)?;
    let samples_b = read_wav_16k(&path_b)?;

    let started = std::time::Instant::now();
    let result = with_speaker_embedder(&state, model, |embedder| {
        let a = embedder.embed(&samples_a)?;
        let b = embedder.embed(&samples_b)?;
        Ok((cosine_similarity(&a, &b), embedder.dim()))
    })?;
    let (similarity, embedding_dim) = result;
    let processing_ms = started.elapsed().as_secs_f64() * 1000.0;
    log::info!(
        "[speech] speaker compare: similarity {similarity:.3} (threshold {threshold}) in {processing_ms:.0}ms"
    );
    Ok(SpeakerCompareResult {
        similarity,
        is_match: similarity >= threshold,
        threshold,
        embedding_dim,
        processing_ms,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrolledClip {
    pub name: String,
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerScore {
    pub name: String,
    pub score: f32,
    pub is_match: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerIdentifyResult {
    /// Every enrolled speaker, ranked by score (matches flagged at threshold).
    pub scores: Vec<SpeakerScore>,
    /// Best matching name, if any score cleared the threshold.
    pub best: Option<String>,
    pub threshold: f32,
    pub processing_ms: f64,
}

/// Speaker identification: who (of the enrolled clips) speaks in `path`?
/// Multiple clips may share a name — their embeddings are averaged by the
/// sherpa embedding manager.
#[tauri::command]
pub fn speaker_identify_file(
    state: State<'_, SpeechState>,
    path: String,
    enrolled: Vec<EnrolledClip>,
    model: Option<String>,
    threshold: Option<f32>,
) -> Result<SpeakerIdentifyResult, String> {
    if enrolled.is_empty() {
        return Err("enroll at least one reference clip first".into());
    }
    let threshold = threshold.unwrap_or(0.5);
    let probe = read_wav_16k(&path)?;

    let started = std::time::Instant::now();
    let mut scores = with_speaker_embedder(&state, model, |embedder| {
        let manager = embedder.manager()?;
        // Group per name so repeat enrollments average instead of colliding.
        let mut by_name: Vec<(String, Vec<Vec<f32>>)> = Vec::new();
        for clip in &enrolled {
            let embedding = embedder
                .embed(&read_wav_16k(&clip.path)?)
                .map_err(|e| format!("{}: {e}", clip.name))?;
            match by_name.iter_mut().find(|(name, _)| *name == clip.name) {
                Some((_, list)) => list.push(embedding),
                None => by_name.push((clip.name.clone(), vec![embedding])),
            }
        }
        for (name, embeddings) in &by_name {
            if !manager.add_list(name, embeddings) {
                return Err(format!("failed to enroll {name}"));
            }
        }
        let probe_embedding = embedder.embed(&probe)?;
        // Threshold -1 returns every speaker's score; we flag matches ourselves
        // so the UI can show near-misses too.
        Ok(manager.get_best_matches(&probe_embedding, -1.0, by_name.len() as i32))
    })?
    .into_iter()
    .map(|m| SpeakerScore {
        is_match: m.score >= threshold,
        name: m.name,
        score: m.score,
    })
    .collect::<Vec<_>>();
    scores.sort_by(|a, b| b.score.total_cmp(&a.score));
    let processing_ms = started.elapsed().as_secs_f64() * 1000.0;

    let best = scores
        .first()
        .filter(|top| top.is_match)
        .map(|top| top.name.clone());
    log::info!(
        "[speech] speaker identify: best {:?} of {} enrolled in {processing_ms:.0}ms",
        best,
        scores.len()
    );
    Ok(SpeakerIdentifyResult {
        scores,
        best,
        threshold,
        processing_ms,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarizeFileResult {
    pub duration_secs: f64,
    pub processing_ms: f64,
    pub num_speakers: i32,
    pub segments: Vec<DiarizationSegment>,
}

/// Offline diarization: who spoke when in a wav file. `num_speakers` = 0 or
/// None means auto (cluster by `threshold`).
#[tauri::command]
pub fn diarize_file(
    state: State<'_, SpeechState>,
    path: String,
    model: Option<String>,
    embedding_model: Option<String>,
    num_speakers: Option<i32>,
    threshold: Option<f32>,
) -> Result<DiarizeFileResult, String> {
    let segmentation_dir = resolve_model_dir("diarization", model, "diarization")?;
    let embedding_dir =
        resolve_model_dir("speaker-embedding", embedding_model, "speaker embedding")?;
    let params = DiarizationParams {
        num_speakers: num_speakers.filter(|n| *n >= 1),
        threshold: threshold.unwrap_or(DiarizationParams::default().threshold),
    };
    let samples = read_wav_16k(&path)?;
    let duration_secs = samples.len() as f64 / TARGET_SAMPLE_RATE as f64;

    let mut guard = state.diarizer.lock().unwrap();
    let stale = !matches!(
        guard.as_ref(),
        Some(slot) if slot.segmentation_dir == segmentation_dir
            && slot.embedding_dir == embedding_dir
    );
    if stale {
        log::info!(
            "[speech] loading diarizer from {} + {}",
            segmentation_dir.display(),
            embedding_dir.display()
        );
        *guard = Some(DiarizerSlot {
            engine: Diarizer::new(&segmentation_dir, &embedding_dir, DIARIZE_THREADS)?,
            segmentation_dir,
            embedding_dir,
        });
    }
    let engine = &guard.as_ref().unwrap().engine;

    let started = std::time::Instant::now();
    let (segments, found_speakers) = engine.diarize(&samples, params)?;
    let processing_ms = started.elapsed().as_secs_f64() * 1000.0;
    log::info!(
        "[speech] diarized {path}: {} speakers, {} segments over {duration_secs:.1}s in {processing_ms:.0}ms",
        found_speakers,
        segments.len()
    );
    Ok(DiarizeFileResult {
        duration_secs,
        processing_ms,
        num_speakers: found_speakers,
        segments,
    })
}

// ── Keyword spotting ────────────────────────────────────────────────────────

/// Live mic → keyword-spotter pipeline for the playground KWS tool. Emits
/// KeywordHit and Level events; stopped through the same asr_pipeline_stop
/// registry. `keywords` is the newline-joined keyword list (empty = model
/// defaults).
#[tauri::command]
pub fn kws_pipeline_start(
    state: State<'_, SpeechState>,
    channel: Channel<PipelineEvent>,
    keywords: String,
    keywords_score: Option<f32>,
    model: Option<String>,
    input_device: Option<String>,
) -> Result<u32, String> {
    let model_dir = resolve_model_dir("kws", model, "keyword spotting")?;
    let id = start_kws_pipeline(
        &state.pipelines,
        KwsPipelineModels {
            model_dir,
            keywords,
            keywords_score: keywords_score.unwrap_or(1.0),
            num_threads: KWS_THREADS,
            input_device,
        },
        channel,
    );
    log::info!("[speech] started kws pipeline {id}");
    Ok(id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KwsDefaults {
    /// Bundled keywords in sherpa's tokenized BPE form (keywords.txt), one per
    /// line — this is what the engine consumes directly.
    pub tokens: String,
    /// The same keywords as human phrases (keywords_raw.txt), aligned line for
    /// line; empty when the model ships no raw file.
    pub phrases: String,
}

/// The KWS model's bundled keyword list. sherpa's spotter needs BPE-tokenized
/// keywords, so the tool seeds its editor from here rather than accepting plain
/// text (runtime tokenization isn't exposed by the C API — spec caveat).
#[tauri::command]
pub fn kws_default_keywords(model: Option<String>) -> Result<KwsDefaults, String> {
    let model_dir = resolve_model_dir("kws", model, "keyword spotting")?;
    let tokens = std::fs::read_to_string(model_dir.join("keywords.txt")).unwrap_or_default();
    let phrases = std::fs::read_to_string(model_dir.join("keywords_raw.txt")).unwrap_or_default();
    Ok(KwsDefaults { tokens, phrases })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KwsAnalysis {
    pub duration_secs: f64,
    pub hits: Vec<KeywordHit>,
}

/// Offline keyword spotting over a wav — the KWS tool's file mode.
#[tauri::command]
pub fn kws_analyze_file(
    path: String,
    keywords: String,
    keywords_score: Option<f32>,
    model: Option<String>,
) -> Result<KwsAnalysis, String> {
    let model_dir = resolve_model_dir("kws", model, "keyword spotting")?;
    let samples = read_wav_16k(&path)?;
    let duration_secs = samples.len() as f64 / TARGET_SAMPLE_RATE as f64;
    let hits = spot_keywords_in_clip(
        &model_dir,
        KWS_THREADS,
        keywords_score.unwrap_or(1.0),
        &keywords,
        &samples,
    )?;
    log::info!("[speech] kws analyzed {path}: {} hits", hits.len());
    Ok(KwsAnalysis {
        duration_secs,
        hits,
    })
}

// ── Spoken language identification ───────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LangIdResult {
    /// ISO 639-1 code whisper reports (e.g. "en", "fr").
    pub lang: String,
    pub processing_ms: f64,
}

/// Identify the spoken language of a wav — the playground language-ID tool.
#[tauri::command]
pub fn langid_file(
    state: State<'_, SpeechState>,
    path: String,
    model: Option<String>,
) -> Result<LangIdResult, String> {
    let model_dir = resolve_model_dir("lang-id", model, "language ID")?;
    let samples = read_wav_16k(&path)?;

    let mut guard = state.langid.lock().unwrap();
    if !matches!(guard.as_ref(), Some(slot) if slot.model_dir == model_dir) {
        log::info!("[speech] loading language-ID from {}", model_dir.display());
        *guard = Some(LangIdSlot {
            engine: LangIdentifier::new(&model_dir, LANGID_THREADS)?,
            model_dir,
        });
    }
    let started = std::time::Instant::now();
    let lang = guard.as_ref().unwrap().engine.identify(&samples)?;
    let processing_ms = started.elapsed().as_secs_f64() * 1000.0;
    log::info!("[speech] langid {path}: {lang} in {processing_ms:.0}ms");
    Ok(LangIdResult { lang, processing_ms })
}

// ── Source separation ────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparatedStemInfo {
    /// Stem label ("vocals" / "accompaniment" for Spleeter 2-stems).
    pub name: String,
    pub wav_path: String,
    pub duration_secs: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparateResult {
    pub stems: Vec<SeparatedStemInfo>,
    pub processing_ms: f64,
}

/// Names for Spleeter's two stems, in the order the model emits them.
const SPLEETER_STEM_NAMES: [&str; 2] = ["vocals", "accompaniment"];

/// Offline source separation over a wav — the playground separation tool
/// (file input only). Stems are written next to the run json under
/// ~/.vocalis/playground/separation/runs/<stamp>/ as mono wavs (spec §4).
#[tauri::command]
pub fn separate_file(
    state: State<'_, SpeechState>,
    path: String,
    model: Option<String>,
) -> Result<SeparateResult, String> {
    let model_dir = resolve_model_dir("separation", model, "source separation")?;
    // Native-rate mono decode: separation quality (and the model's own rate)
    // should not be pinned to the 16 kHz realtime rate.
    let (samples, input_rate) = crate::audio::decode_native_mono(std::path::Path::new(&path))?;

    let mut guard = state.separator.lock().unwrap();
    if !matches!(guard.as_ref(), Some(slot) if slot.model_dir == model_dir) {
        log::info!("[speech] loading source separation from {}", model_dir.display());
        *guard = Some(SeparatorSlot {
            engine: SourceSeparator::new(&model_dir, SEPARATION_THREADS)?,
            model_dir,
        });
    }

    let started = std::time::Instant::now();
    let stems = guard.as_ref().unwrap().engine.separate(&samples, input_rate)?;
    let processing_ms = started.elapsed().as_secs_f64() * 1000.0;

    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let out_dir = app_data_dir()?
        .join("playground/separation/runs")
        .join(millis.to_string());
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let mut infos = Vec::with_capacity(stems.len());
    for (i, stem) in stems.iter().enumerate() {
        let name = SPLEETER_STEM_NAMES
            .get(i)
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("stem-{}", i + 1));
        let wav_path = out_dir.join(format!("{name}.wav"));
        let path_str = wav_path.to_string_lossy().into_owned();
        if !sherpa_onnx::write(&path_str, &stem.samples, stem.sample_rate as i32) {
            return Err(format!("failed to write stem wav to {path_str}"));
        }
        infos.push(SeparatedStemInfo {
            name,
            duration_secs: stem.samples.len() as f64 / stem.sample_rate.max(1) as f64,
            wav_path: path_str,
        });
    }
    log::info!(
        "[speech] separated {path}: {} stems in {processing_ms:.0}ms",
        infos.len()
    );
    Ok(SeparateResult {
        stems: infos,
        processing_ms,
    })
}

/// Duration/rate of an audio file — library rows and input validation in the
/// bench.
#[tauri::command]
pub fn audio_file_info(path: String) -> Result<AudioFileInfo, String> {
    let (samples, rate) = crate::audio::decode_native_mono(std::path::Path::new(&path))?;
    Ok(AudioFileInfo {
        duration_secs: samples.len() as f64 / rate.max(1) as f64,
        sample_rate: rate,
    })
}
