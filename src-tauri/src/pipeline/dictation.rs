use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::ipc::Channel;

use crate::audio::AudioCapture;
use crate::engines::{OfflineAsr, SpeechDetector};
use crate::pipeline::{transcribe_utterance, PipelineEvent};

/// The dictation thread owns capture and all engine sessions. Commands only
/// send this small control message; raw audio never leaves the thread.
enum DictationControl {
    Finalize(mpsc::Sender<Result<String, String>>),
    Cancel,
}

/// A registered dictation: its control channel plus the model paths it holds
/// open, so the model-deletion guard can see dictations too (spec §2.5).
struct DictationEntry {
    control: mpsc::Sender<DictationControl>,
    paths: Vec<PathBuf>,
}

/// Handles for active dictations. A handle is consumed by finalize/cancel so
/// an id has exactly one terminal action.
#[derive(Clone, Default)]
pub struct DictationRegistry {
    next_id: Arc<AtomicU32>,
    entries: Arc<Mutex<HashMap<u32, DictationEntry>>>,
}

impl DictationRegistry {
    fn register(
        &self,
        control: mpsc::Sender<DictationControl>,
        paths: Vec<PathBuf>,
    ) -> Result<u32, String> {
        let mut entries = self.entries.lock().unwrap();
        if !entries.is_empty() {
            return Err("dictation is already active".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        entries.insert(id, DictationEntry { control, paths });
        Ok(id)
    }

    fn finish(&self, id: u32) {
        self.entries.lock().unwrap().remove(&id);
    }

    /// Every model path currently held open by a running dictation.
    pub fn paths_in_use(&self) -> Vec<PathBuf> {
        self.entries
            .lock()
            .unwrap()
            .values()
            .flat_map(|e| e.paths.iter().cloned())
            .collect()
    }

    /// Request final text from the capture thread. Finalize now blocks on a
    /// real batch decode (not just a stream flush) of whatever's buffered —
    /// measured whisper-small-int8 RTF is ~0.12 at the pipeline's 2 threads,
    /// so even the worst case (the full 90s dictation cap spoken as one
    /// unbroken utterance) decodes in ~11s. 20s leaves headroom above that
    /// while still catching a genuinely hung audio/engine thread.
    pub fn finalize(&self, id: u32) -> Result<String, String> {
        let control = self
            .entries
            .lock()
            .unwrap()
            .remove(&id)
            .ok_or_else(|| format!("no running dictation with id {id}"))?
            .control;
        let (result_tx, result_rx) = mpsc::channel();
        control
            .send(DictationControl::Finalize(result_tx))
            .map_err(|_| "dictation pipeline stopped unexpectedly".to_string())?;
        result_rx
            .recv_timeout(Duration::from_secs(20))
            .map_err(|_| "dictation finalization timed out".to_string())?
    }

    pub fn cancel(&self, id: u32) -> Result<(), String> {
        let control = self
            .entries
            .lock()
            .unwrap()
            .remove(&id)
            .ok_or_else(|| format!("no running dictation with id {id}"))?
            .control;
        control
            .send(DictationControl::Cancel)
            .map_err(|_| "dictation pipeline stopped unexpectedly".to_string())
    }

    /// Emergency shutdown for the global cancel shortcut and application exit.
    pub fn cancel_all(&self) {
        let entries = std::mem::take(&mut *self.entries.lock().unwrap());
        for entry in entries.into_values() {
            let _ = entry.control.send(DictationControl::Cancel);
        }
    }
}

pub struct DictationPipelineModels {
    pub asr_dir: PathBuf,
    pub vad_path: PathBuf,
    pub num_threads: i32,
    /// Preferred capture device name; None = system default.
    pub input_device: Option<String>,
}

/// Start a mic → VAD → batch ASR dictation run: one decode per VAD-bounded
/// utterance, on the falling edge (spec §0/§3.2). Audio is held only by the
/// capture/engine thread and discarded as soon as it exits.
pub fn start_dictation_pipeline(
    registry: &DictationRegistry,
    models: DictationPipelineModels,
    channel: Channel<PipelineEvent>,
) -> Result<u32, String> {
    let (control_tx, control_rx) = mpsc::channel();
    let paths = vec![models.vad_path.clone(), models.asr_dir.clone()];
    let id = registry.register(control_tx, paths)?;
    let thread_registry = registry.clone();

    std::thread::Builder::new()
        .name(format!("dictation-pipeline-{id}"))
        .spawn(move || {
            run_dictation_pipeline(models, channel, control_rx);
            thread_registry.finish(id);
        })
        .expect("failed to spawn dictation pipeline thread");

    Ok(id)
}

fn append_segment(transcript: &mut Vec<String>, text: String) {
    let text = text.trim();
    if !text.is_empty() {
        transcript.push(text.to_string());
    }
}

fn run_dictation_pipeline(
    models: DictationPipelineModels,
    channel: Channel<PipelineEvent>,
    control_rx: mpsc::Receiver<DictationControl>,
) {
    let send = |event: PipelineEvent| {
        let _ = channel.send(event);
    };

    let mut vad = match SpeechDetector::new(&models.vad_path) {
        Ok(vad) => vad,
        Err(message) => return send(PipelineEvent::Error { message }),
    };
    let asr = match OfflineAsr::new(&models.asr_dir, models.num_threads, None) {
        Ok(asr) => asr,
        Err(message) => return send(PipelineEvent::Error { message }),
    };
    let (audio_tx, audio_rx) = mpsc::channel::<Vec<f32>>();
    let capture = match AudioCapture::start(audio_tx, models.input_device.as_deref()) {
        Ok(capture) => capture,
        Err(message) => return send(PipelineEvent::Error { message }),
    };

    send(PipelineEvent::Ready {
        device: capture.device_name.clone(),
        input_rate: capture.input_rate,
    });

    let mut transcript = Vec::new();
    // Utterance-local buffer, cleared after every decode (mirrors
    // chat_capture.rs) — dictation never needs the whole session's audio.
    let mut buffer: Vec<f32> = Vec::new();
    let mut in_utterance = false;
    let started_at = Instant::now();
    loop {
        // A missed release must not leave microphone/ASR work running forever.
        // The user sees an error and can immediately start a new dictation.
        if started_at.elapsed() >= Duration::from_secs(90) {
            capture.stop();
            send(PipelineEvent::Error {
                message: "dictation stopped after 90 seconds".into(),
            });
            send(PipelineEvent::Stopped);
            return;
        }
        match control_rx.try_recv() {
            Ok(DictationControl::Finalize(result_tx)) => {
                // Key-release before a natural VAD falling edge: treat
                // whatever's buffered as a synthetic falling edge. A fresh
                // never-cancel flag mirrors chat_capture.rs's ForceFinalize —
                // this decode must run to completion.
                if in_utterance {
                    let no_cancel = AtomicBool::new(false);
                    decode_and_append(&asr, &buffer, &no_cancel, &mut transcript, &send);
                }
                capture.stop();
                let _ = result_tx.send(Ok(transcript.join(" ")));
                send(PipelineEvent::Stopped);
                return;
            }
            Ok(DictationControl::Cancel) => {
                capture.stop();
                send(PipelineEvent::Stopped);
                return;
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                capture.stop();
                return;
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }

        match audio_rx.recv_timeout(Duration::from_millis(30)) {
            Ok(samples) => {
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
                        let no_cancel = AtomicBool::new(false);
                        decode_and_append(&asr, &buffer, &no_cancel, &mut transcript, &send);
                        buffer.clear();
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                capture.stop();
                send(PipelineEvent::Error {
                    message: "audio capture stopped unexpectedly".into(),
                });
                return;
            }
        }
    }
}

/// Batch-decode one VAD-bounded utterance and, if it produced any text,
/// append it to the running transcript and emit a `Final`. Sends
/// `Processing` first so the frontend can show "Transcribing…" for the
/// decode window.
fn decode_and_append(
    asr: &OfflineAsr,
    buffer: &[f32],
    stop: &AtomicBool,
    transcript: &mut Vec<String>,
    send: &dyn Fn(PipelineEvent),
) {
    send(PipelineEvent::Processing {
        message: "transcribing".into(),
    });
    match transcribe_utterance(asr, buffer, stop) {
        Ok(Some(transcription)) => {
            append_segment(transcript, transcription.text.clone());
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
    use super::append_segment;

    #[test]
    fn transcript_segments_are_trimmed_and_joined_without_empty_entries() {
        let mut transcript = Vec::new();
        append_segment(&mut transcript, "  hello there  ".into());
        append_segment(&mut transcript, " \n ".into());
        append_segment(&mut transcript, "general kenobi".into());
        assert_eq!(transcript.join(" "), "hello there general kenobi");
    }
}
