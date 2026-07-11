use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;

use crate::audio::AudioCapture;
use crate::engines::{KeywordSession, SpeechDetector, StreamingAsrSession, VadParams, WordSpan};

mod chat_capture;
mod dictation;
mod import;
mod live_session;
mod recorder;
mod speakers;
mod vad_batch;

pub use chat_capture::*;
pub use dictation::*;
pub use import::*;
pub use live_session::*;
pub use recorder::*;
pub use speakers::*;
pub use vad_batch::*;

/// A finalized session segment, as carried by `SpeakerTurn` (live, provisional)
/// and `Refined` (post-stop, settled). Mirrors the webview `TranscriptSegment`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSegment {
    pub text: String,
    pub start_ms: f64,
    pub end_ms: f64,
    /// Display cluster label ("A", "B", …).
    pub speaker_label: String,
    /// Matched enrolled Person, when one crossed the match threshold.
    pub person_id: Option<String>,
}

/// Events streamed to the webview over a Tauri channel — spec §3.2.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PipelineEvent {
    Ready {
        device: String,
        #[serde(rename = "inputRate")]
        input_rate: u32,
    },
    Partial {
        text: String,
        /// Decode wall time for this update (capture→partial compute latency).
        #[serde(rename = "latencyMs")]
        latency_ms: f32,
    },
    Final {
        text: String,
        /// Word timestamps relative to the utterance start (empty when the
        /// model reports none).
        words: Vec<WordSpan>,
    },
    VadState {
        speaking: bool,
    },
    /// A finalized session turn with an online (provisional) speaker label —
    /// spec §3.2. Emitted by the live session pipeline in place of `Final`.
    SpeakerTurn {
        segment: SessionSegment,
    },
    /// The session is running its stop-time refinement pass (diarization +
    /// re-labeling). Lets the UI show a "processing" state.
    Processing {
        message: String,
    },
    /// Fractional progress [0,1] of a batch job (file import) — spec §2.2B.
    Progress {
        fraction: f32,
    },
    /// Stop-time refinement finished: the settled, non-provisional transcript.
    Refined {
        segments: Vec<SessionSegment>,
    },
    /// A keyword fired in the live KWS pipeline. `startTime` is seconds of audio
    /// processed since the stream began.
    KeywordHit {
        keyword: String,
        #[serde(rename = "startTime")]
        start_time: f32,
    },
    /// Rolling input level for meters/waveforms — derived stats only; raw
    /// audio never crosses the boundary (spec §3.2).
    Level {
        rms: f32,
        peak: f32,
    },
    Error {
        message: String,
    },
    Stopped,
    /// A batch import (or other cancellable run) was stopped by user request
    /// before it settled — distinct from `Stopped`, so the caller doesn't
    /// treat a cancelled, truncated transcript as a completed one.
    Cancelled,
}

/// How often live pipelines report input level. ~30 ms tracks speech onset
/// closely enough for a meter without flooding the IPC channel.
pub(crate) const LEVEL_INTERVAL: Duration = Duration::from_millis(30);

/// Level stats over one batch of samples.
pub(crate) fn level_of(samples: &[f32]) -> (f32, f32) {
    let mut peak = 0f32;
    let mut sum_sq = 0f32;
    for &s in samples {
        peak = peak.max(s.abs());
        sum_sq += s * s;
    }
    let rms = (sum_sq / samples.len().max(1) as f32).sqrt();
    (rms, peak)
}

/// A running pipeline's stop flag plus the model paths it holds open, so the
/// model-deletion guard can tell what's in use (spec §2.5).
struct PipelineEntry {
    stop: Arc<AtomicBool>,
    /// Model files/dirs this pipeline loaded (e.g. the VAD .onnx + the ASR dir).
    paths: Vec<PathBuf>,
}

/// Managed state: running pipelines by id, each stoppable via an atomic flag.
/// Clone is cheap (Arc-internal) so a running pipeline's thread can hold its
/// own handle and deregister itself on exit — mirrors `DictationRegistry`.
#[derive(Clone, Default)]
pub struct PipelineRegistry {
    next_id: Arc<AtomicU32>,
    entries: Arc<Mutex<HashMap<u32, PipelineEntry>>>,
}

impl PipelineRegistry {
    /// Signal a pipeline to stop. The entry (and its in-use model paths) stays
    /// registered until the thread actually exits and calls `finish` — so the
    /// model-deletion guard keeps seeing those paths as busy during the
    /// stop-time flush/refinement, not just up to the moment stop() was called.
    pub fn stop(&self, id: u32) -> bool {
        match self.entries.lock().unwrap().get(&id) {
            Some(entry) => {
                entry.stop.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    pub fn stop_all(&self) {
        for entry in self.entries.lock().unwrap().values() {
            entry.stop.store(true, Ordering::Relaxed);
        }
    }

    /// Every model path currently held open by a running pipeline.
    pub fn paths_in_use(&self) -> Vec<PathBuf> {
        self.entries
            .lock()
            .unwrap()
            .values()
            .flat_map(|e| e.paths.iter().cloned())
            .collect()
    }

    fn register(&self, paths: Vec<PathBuf>) -> (u32, Arc<AtomicBool>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let flag = Arc::new(AtomicBool::new(false));
        self.entries.lock().unwrap().insert(
            id,
            PipelineEntry {
                stop: flag.clone(),
                paths,
            },
        );
        (id, flag)
    }

    /// Drop a pipeline's entry once its thread has actually exited, whether
    /// it was told to stop or died on its own (error / disconnect / panic).
    /// Without this, self-terminating runs leave their model paths "in use"
    /// forever, blocking deletion until the app restarts.
    pub fn finish(&self, id: u32) {
        self.entries.lock().unwrap().remove(&id);
    }
}

/// Runs a closure when dropped, including during a panic unwind. Every
/// pipeline thread spawn wraps its body in one of these (tied to `finish`,
/// and where relevant an `active` flag reset) so a panicking engine call
/// can't leave a pipeline's model paths permanently marked "in use" or a
/// single-session guard permanently stuck "busy".
pub(crate) struct DropGuard<F: FnMut()>(F);

impl<F: FnMut()> DropGuard<F> {
    pub(crate) fn new(f: F) -> Self {
        DropGuard(f)
    }
}

impl<F: FnMut()> Drop for DropGuard<F> {
    fn drop(&mut self) {
        (self.0)();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_tracks_paths_and_clears_on_finish() {
        let registry = PipelineRegistry::default();
        let (id_a, flag_a) = registry.register(vec![PathBuf::from("/m/vad/silero")]);
        let (_id_b, _) = registry.register(vec![
            PathBuf::from("/m/kws/gigaspeech"),
            PathBuf::from("/m/asr/zipformer"),
        ]);

        let in_use = registry.paths_in_use();
        assert_eq!(in_use.len(), 3, "all registered paths are reported");
        assert!(in_use.contains(&PathBuf::from("/m/vad/silero")));

        // Stopping a pipeline flips its flag but its paths stay reserved —
        // the thread is still flushing/writing until it calls finish().
        assert!(registry.stop(id_a));
        assert!(flag_a.load(Ordering::Relaxed));
        assert_eq!(registry.paths_in_use().len(), 3);
        assert!(registry.paths_in_use().contains(&PathBuf::from("/m/vad/silero")));

        // Stopping an already-stopped id is idempotent, not an error.
        assert!(registry.stop(id_a));

        // Only finish() actually releases the paths.
        registry.finish(id_a);
        assert_eq!(registry.paths_in_use().len(), 2);
        assert!(!registry.paths_in_use().contains(&PathBuf::from("/m/vad/silero")));

        // Stopping a finished (stale) id is a no-op.
        assert!(!registry.stop(id_a));
    }
}

pub struct AsrPipelineModels {
    /// None = VAD-only pipeline (the playground VAD tool's live mode).
    pub asr_dir: Option<PathBuf>,
    pub vad_path: PathBuf,
    pub vad_params: VadParams,
    pub num_threads: i32,
    /// Preferred capture device name; None = system default.
    pub input_device: Option<String>,
}

/// Start the live mic → VAD → streaming-ASR pipeline on its own thread.
///
/// Everything audio-related (cpal stream, sherpa sessions) lives on that
/// thread; only serialized events cross to the webview. Returns the pipeline
/// id immediately; readiness/errors arrive as events.
pub fn start_asr_pipeline(
    registry: &PipelineRegistry,
    models: AsrPipelineModels,
    channel: Channel<PipelineEvent>,
) -> u32 {
    let mut paths = vec![models.vad_path.clone()];
    paths.extend(models.asr_dir.clone());
    let (id, stop) = registry.register(paths);
    let thread_registry = registry.clone();

    std::thread::Builder::new()
        .name(format!("asr-pipeline-{id}"))
        .spawn(move || {
            let _finish = DropGuard::new(|| thread_registry.finish(id));
            run_asr_pipeline(models, channel, stop);
        })
        .expect("failed to spawn pipeline thread");

    id
}

fn run_asr_pipeline(
    models: AsrPipelineModels,
    channel: Channel<PipelineEvent>,
    stop: Arc<AtomicBool>,
) {
    let send = |event: PipelineEvent| {
        let _ = channel.send(event);
    };

    let mut vad = match SpeechDetector::with_params(&models.vad_path, models.vad_params) {
        Ok(v) => v,
        Err(e) => return send(PipelineEvent::Error { message: e }),
    };
    let mut asr = match models
        .asr_dir
        .as_deref()
        .map(|dir| StreamingAsrSession::new(dir, models.num_threads))
        .transpose()
    {
        Ok(a) => a,
        Err(e) => return send(PipelineEvent::Error { message: e }),
    };

    let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
    let capture = match AudioCapture::start(tx, models.input_device.as_deref()) {
        Ok(c) => c,
        Err(e) => return send(PipelineEvent::Error { message: e }),
    };

    send(PipelineEvent::Ready {
        device: capture.device_name.clone(),
        input_rate: capture.input_rate,
    });

    let mut last_level = std::time::Instant::now();
    while !stop.load(Ordering::Relaxed) && !capture.stream_error.load(Ordering::Relaxed) {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(samples) => {
                if last_level.elapsed() >= LEVEL_INTERVAL {
                    last_level = std::time::Instant::now();
                    let (rms, peak) = level_of(&samples);
                    send(PipelineEvent::Level { rms, peak });
                }
                if let Some(speaking) = vad.push(&samples) {
                    send(PipelineEvent::VadState { speaking });
                }
                if let Some(asr) = asr.as_mut() {
                    let decode_started = std::time::Instant::now();
                    if let Some(text) = asr.push(&samples) {
                        send(PipelineEvent::Partial {
                            text,
                            latency_ms: decode_started.elapsed().as_secs_f32() * 1000.0,
                        });
                    }
                    if let Some(segment) = asr.take_final() {
                        send(PipelineEvent::Final {
                            text: segment.text,
                            words: segment.words,
                        });
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    if capture.stream_error.load(Ordering::Relaxed) {
        send(PipelineEvent::Error {
            message: "audio input device disconnected".into(),
        });
    }
    capture.stop();
    send(PipelineEvent::Stopped);
}

pub struct KwsPipelineModels {
    pub model_dir: PathBuf,
    /// Newline-joined keyword list; empty uses the model's bundled keywords.
    pub keywords: String,
    pub keywords_score: f32,
    pub num_threads: i32,
    pub input_device: Option<String>,
}

/// Start the live mic → keyword-spotter pipeline on its own thread (spec §2.3
/// KWS tool). Emits `KeywordHit` and `Level` events; stopped through the same
/// `asr_pipeline_stop` registry as the other live pipelines.
pub fn start_kws_pipeline(
    registry: &PipelineRegistry,
    models: KwsPipelineModels,
    channel: Channel<PipelineEvent>,
) -> u32 {
    let (id, stop) = registry.register(vec![models.model_dir.clone()]);
    let thread_registry = registry.clone();

    std::thread::Builder::new()
        .name(format!("kws-pipeline-{id}"))
        .spawn(move || {
            let _finish = DropGuard::new(|| thread_registry.finish(id));
            run_kws_pipeline(models, channel, stop);
        })
        .expect("failed to spawn pipeline thread");

    id
}

fn run_kws_pipeline(
    models: KwsPipelineModels,
    channel: Channel<PipelineEvent>,
    stop: Arc<AtomicBool>,
) {
    let send = |event: PipelineEvent| {
        let _ = channel.send(event);
    };

    let session = match KeywordSession::new(
        &models.model_dir,
        models.num_threads,
        models.keywords_score,
        &models.keywords,
    ) {
        Ok(s) => s,
        Err(e) => return send(PipelineEvent::Error { message: e }),
    };

    let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
    let capture = match AudioCapture::start(tx, models.input_device.as_deref()) {
        Ok(c) => c,
        Err(e) => return send(PipelineEvent::Error { message: e }),
    };

    send(PipelineEvent::Ready {
        device: capture.device_name.clone(),
        input_rate: capture.input_rate,
    });

    let mut last_level = std::time::Instant::now();
    while !stop.load(Ordering::Relaxed) && !capture.stream_error.load(Ordering::Relaxed) {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(samples) => {
                if last_level.elapsed() >= LEVEL_INTERVAL {
                    last_level = std::time::Instant::now();
                    let (rms, peak) = level_of(&samples);
                    send(PipelineEvent::Level { rms, peak });
                }
                for hit in session.push(&samples) {
                    send(PipelineEvent::KeywordHit {
                        keyword: hit.keyword,
                        start_time: hit.start_time,
                    });
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    if capture.stream_error.load(Ordering::Relaxed) {
        send(PipelineEvent::Error {
            message: "audio input device disconnected".into(),
        });
    }
    capture.stop();
    send(PipelineEvent::Stopped);
}
