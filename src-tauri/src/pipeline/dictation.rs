use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::ipc::Channel;

use crate::audio::AudioCapture;
use crate::engines::{SpeechDetector, StreamingAsrSession};
use crate::pipeline::PipelineEvent;

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

    /// Request final text from the capture thread. The brief timeout prevents
    /// a failed audio/engine thread from hanging a Tauri command indefinitely.
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
            .recv_timeout(Duration::from_secs(5))
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

/// Start a mic → VAD → streaming ASR dictation run. Audio is held only by the
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
    let mut asr = match StreamingAsrSession::new(&models.asr_dir, models.num_threads) {
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
                append_segment(&mut transcript, asr.finish().unwrap_or_default());
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
                if let Some(speaking) = vad.push(&samples) {
                    send(PipelineEvent::VadState { speaking });
                }
                let decode_started = Instant::now();
                if let Some(text) = asr.push(&samples) {
                    send(PipelineEvent::Partial {
                        text,
                        latency_ms: decode_started.elapsed().as_secs_f32() * 1000.0,
                    });
                }
                if let Some(segment) = asr.take_final() {
                    append_segment(&mut transcript, segment.text.clone());
                    send(PipelineEvent::Final {
                        text: segment.text,
                        words: segment.words,
                    });
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
