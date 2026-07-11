use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::ipc::Channel;

use crate::audio::AudioCapture;
use crate::engines::{OfflineAsr, SpeechDetector, VadParams};
use crate::pipeline::{level_of, transcribe_utterance, DropGuard, PipelineEvent, LEVEL_INTERVAL};

// The voice-chat capture pipeline (spec M4 item 3/4). Structurally mirrors
// `run_asr_pipeline` in `mod.rs`, not `dictation.rs`'s single-shot model: the
// thread keeps running for the whole conversation, so successive `Final`
// events naturally land across multiple turns. On top of that it adds a
// `dictation.rs`-style control channel for two things a plain continuous
// pipeline doesn't need: pausing capture into VAD/ASR while TTS plays (echo
// mitigation v1, spec §3.2/§7.4 — no barge-in, capture just resumes once
// playback drains) and push-to-talk force-finalize.
//
// Turn boundaries are VAD-driven, not ASR-driven (spec §0/§3.2): unlike
// `live_session.rs`, which retains the whole session for the scrubber, this
// pipeline only buffers the current VAD-bounded utterance and drains it after
// each batch decode — bounded memory over a long-running conversation.

/// Non-terminal control messages. Distinct from `stop` (which ends the
/// pipeline for good) — both of these can arrive any number of times across a
/// multi-turn conversation.
enum ChatCaptureControl {
    /// Pauses (true) or resumes (false) mic capture into VAD/ASR while TTS
    /// plays — echo mitigation v1 (spec §3.2/§7.4). While paused, audio
    /// samples are still drained off the capture channel (so it doesn't back
    /// up) but never reach the VAD detector or the utterance buffer.
    SetPlaybackActive(bool),
    /// Push-to-talk: force-finalize the in-progress utterance immediately,
    /// without waiting for a VAD/ASR endpoint (key-release).
    ForceFinalize,
}

/// A registered chat-capture pipeline: its stop flag and control channel, plus
/// the model paths it holds open for the model-deletion guard (spec §2.5).
struct ChatCaptureEntry {
    stop: Arc<AtomicBool>,
    control: mpsc::Sender<ChatCaptureControl>,
    paths: Vec<PathBuf>,
}

/// Handles for the active chat-capture pipeline. Single-active like
/// `DictationRegistry` — only one voice-mode conversation listens at a time —
/// but an entry stays registered across turns (continuous, like
/// `PipelineRegistry`) and exposes non-terminal control alongside `stop`.
#[derive(Clone, Default)]
pub struct ChatCaptureRegistry {
    next_id: Arc<AtomicU32>,
    entries: Arc<Mutex<HashMap<u32, ChatCaptureEntry>>>,
}

impl ChatCaptureRegistry {
    fn register(
        &self,
        control: mpsc::Sender<ChatCaptureControl>,
        paths: Vec<PathBuf>,
    ) -> Result<(u32, Arc<AtomicBool>), String> {
        let mut entries = self.entries.lock().unwrap();
        if !entries.is_empty() {
            return Err("a chat capture pipeline is already active".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let stop = Arc::new(AtomicBool::new(false));
        entries.insert(
            id,
            ChatCaptureEntry {
                stop: stop.clone(),
                control,
                paths,
            },
        );
        Ok((id, stop))
    }

    /// Every model path currently held open by the running chat capture.
    pub fn paths_in_use(&self) -> Vec<PathBuf> {
        self.entries
            .lock()
            .unwrap()
            .values()
            .flat_map(|e| e.paths.iter().cloned())
            .collect()
    }

    /// Signal the pipeline to stop. The entry (and its in-use model paths)
    /// stays registered until the thread actually exits and calls `finish` —
    /// mirrors `PipelineRegistry::stop`.
    pub fn stop(&self, id: u32) -> bool {
        match self.entries.lock().unwrap().get(&id) {
            Some(entry) => {
                entry.stop.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    pub fn set_playback_active(&self, id: u32, active: bool) -> Result<(), String> {
        self.send(id, ChatCaptureControl::SetPlaybackActive(active))
    }

    pub fn force_finalize(&self, id: u32) -> Result<(), String> {
        self.send(id, ChatCaptureControl::ForceFinalize)
    }

    fn send(&self, id: u32, message: ChatCaptureControl) -> Result<(), String> {
        let control = self
            .entries
            .lock()
            .unwrap()
            .get(&id)
            .map(|e| e.control.clone())
            .ok_or_else(|| format!("no running chat capture with id {id}"))?;
        control
            .send(message)
            .map_err(|_| "chat capture pipeline stopped unexpectedly".to_string())
    }

    /// Drop the entry once its thread has actually exited, whether told to
    /// stop or died on its own — same reasoning as `PipelineRegistry::finish`.
    fn finish(&self, id: u32) {
        self.entries.lock().unwrap().remove(&id);
    }
}

pub struct ChatCapturePipelineModels {
    pub asr_dir: PathBuf,
    pub vad_path: PathBuf,
    pub vad_params: VadParams,
    pub num_threads: i32,
    pub input_device: Option<String>,
}

/// Start the continuous mic → VAD → batch-ASR chat pipeline on its own
/// thread. Returns the pipeline id immediately; readiness/errors/finals
/// arrive as events, one turn after another, until `stop`.
pub fn start_chat_capture_pipeline(
    registry: &ChatCaptureRegistry,
    models: ChatCapturePipelineModels,
    channel: Channel<PipelineEvent>,
) -> Result<u32, String> {
    let (control_tx, control_rx) = mpsc::channel();
    let paths = vec![models.vad_path.clone(), models.asr_dir.clone()];
    let (id, stop) = registry.register(control_tx, paths)?;
    let thread_registry = registry.clone();

    std::thread::Builder::new()
        .name(format!("chat-capture-{id}"))
        .spawn(move || {
            let _finish = DropGuard::new(|| thread_registry.finish(id));
            run_chat_capture_pipeline(models, channel, stop, control_rx);
        })
        .expect("failed to spawn chat capture pipeline thread");

    Ok(id)
}

fn run_chat_capture_pipeline(
    models: ChatCapturePipelineModels,
    channel: Channel<PipelineEvent>,
    stop: Arc<AtomicBool>,
    control_rx: mpsc::Receiver<ChatCaptureControl>,
) {
    let send = |event: PipelineEvent| {
        let _ = channel.send(event);
    };

    // Built once; held paused (never pushed to) while playback_active is true
    // — echo mitigation v1 (spec §3.2/§7.4) is a true capture pause, not a
    // threshold boost. Reset on every pause/resume transition so no stale
    // hidden state carries across the gap.
    let mut vad = match SpeechDetector::with_params(&models.vad_path, models.vad_params) {
        Ok(v) => v,
        Err(e) => return send(PipelineEvent::Error { message: e }),
    };
    let asr = match OfflineAsr::new(&models.asr_dir, models.num_threads, None) {
        Ok(a) => a,
        Err(e) => return send(PipelineEvent::Error { message: e }),
    };

    let (audio_tx, audio_rx) = mpsc::channel::<Vec<f32>>();
    let capture = match AudioCapture::start(audio_tx, models.input_device.as_deref()) {
        Ok(c) => c,
        Err(e) => return send(PipelineEvent::Error { message: e }),
    };

    send(PipelineEvent::Ready {
        device: capture.device_name.clone(),
        input_rate: capture.input_rate,
    });

    let mut playback_active = false;
    let mut last_level = Instant::now();
    // Utterance-local buffer, cleared after every decode — only accumulates
    // while `in_utterance`, so idle listening time doesn't grow it.
    let mut buffer: Vec<f32> = Vec::new();
    let mut in_utterance = false;

    while !stop.load(Ordering::Relaxed) && !capture.stream_error.load(Ordering::Relaxed) {
        match control_rx.try_recv() {
            Ok(ChatCaptureControl::SetPlaybackActive(active)) => {
                if active != playback_active {
                    if active && in_utterance {
                        // TTS started while the user was still (or again)
                        // mid-utterance: flush what's buffered rather than
                        // silently dropping it, same never-cancel decode as
                        // ForceFinalize/the stop-tail flush below.
                        in_utterance = false;
                        let no_cancel = AtomicBool::new(false);
                        decode_and_finalize(&asr, &buffer, &no_cancel, &send);
                        buffer.clear();
                    }
                    playback_active = active;
                    vad.reset();
                }
            }
            Ok(ChatCaptureControl::ForceFinalize) => {
                // Push-to-talk key-release: treat whatever's buffered as a
                // synthetic falling edge. A fresh never-cancel flag mirrors
                // live_session.rs's stop-tail flush — this decode must run to
                // completion even if `stop` flips true while it's in flight.
                if in_utterance {
                    in_utterance = false;
                    let no_cancel = AtomicBool::new(false);
                    decode_and_finalize(&asr, &buffer, &no_cancel, &send);
                    buffer.clear();
                }
            }
            Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }

        match audio_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(samples) => {
                if last_level.elapsed() >= LEVEL_INTERVAL {
                    last_level = Instant::now();
                    let (rms, peak) = level_of(&samples);
                    send(PipelineEvent::Level { rms, peak });
                }
                if !playback_active {
                    if in_utterance {
                        buffer.extend_from_slice(&samples);
                    }
                    if let Some(speaking) = vad.push(&samples) {
                        send(PipelineEvent::VadState { speaking });
                        if speaking {
                            in_utterance = true;
                            buffer.clear();
                            buffer.extend_from_slice(&samples);
                        } else if in_utterance {
                            in_utterance = false;
                            decode_and_finalize(&asr, &buffer, &stop, &send);
                            buffer.clear();
                        }
                    }
                }
                // else: playback is active — samples are drained (so the
                // channel doesn't back up) but intentionally never reach
                // VAD/ASR; capture is paused for the duration of playback.
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // Stop requested (or device lost) mid-utterance: flush what's buffered,
    // same reasoning as the ForceFinalize branch above.
    if in_utterance {
        let no_cancel = AtomicBool::new(false);
        decode_and_finalize(&asr, &buffer, &no_cancel, &send);
    }

    if capture.stream_error.load(Ordering::Relaxed) {
        send(PipelineEvent::Error {
            message: "audio input device disconnected".into(),
        });
    }
    capture.stop();
    send(PipelineEvent::Stopped);
}

/// Batch-decode one VAD-bounded utterance and, if it produced any text, emit
/// a `Final`. Sends `Processing` first so the frontend can show
/// "Transcribing…" for the decode window (the PTT 400ms fallback in
/// `use-voice-chat.ts` also gates on having seen this event).
fn decode_and_finalize(
    asr: &OfflineAsr,
    buffer: &[f32],
    stop: &AtomicBool,
    send: &dyn Fn(PipelineEvent),
) {
    send(PipelineEvent::Processing {
        message: "transcribing".into(),
    });
    match transcribe_utterance(asr, buffer, stop) {
        Ok(Some(transcription)) => {
            if !transcription.text.trim().is_empty() {
                send(PipelineEvent::Final {
                    text: transcription.text,
                    words: transcription.words,
                });
            }
        }
        Ok(None) => {}
        Err(message) => send(PipelineEvent::Error { message }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_rejects_a_second_concurrent_capture() {
        let registry = ChatCaptureRegistry::default();
        let (tx_a, _rx_a) = mpsc::channel();
        let (id_a, _stop_a) = registry.register(tx_a, vec![PathBuf::from("/m/vad/silero")]).unwrap();

        let (tx_b, _rx_b) = mpsc::channel();
        let err = registry
            .register(tx_b, vec![PathBuf::from("/m/asr/zipformer")])
            .unwrap_err();
        assert!(err.contains("already active"));

        // Paths stay reserved until finish(), same as PipelineRegistry/DictationRegistry.
        assert_eq!(registry.paths_in_use(), vec![PathBuf::from("/m/vad/silero")]);
        assert!(registry.stop(id_a));
        registry.finish(id_a);
        assert!(registry.paths_in_use().is_empty());
    }

    #[test]
    fn control_send_fails_for_unknown_id() {
        let registry = ChatCaptureRegistry::default();
        assert!(registry.set_playback_active(999, true).is_err());
        assert!(registry.force_finalize(999).is_err());
    }
}
