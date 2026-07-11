use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;

use crate::audio::{AudioCapture, TARGET_SAMPLE_RATE};

use super::{level_of, LEVEL_INTERVAL};

/// Events streamed to the webview while recording a bench clip — same
/// serialized-events-only boundary as PipelineEvent (spec §3.2). The saved
/// clip comes back as a path, never as samples.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RecorderEvent {
    Ready {
        device: String,
        #[serde(rename = "inputRate")]
        input_rate: u32,
    },
    Level {
        rms: f32,
        peak: f32,
    },
    Saved {
        path: String,
        #[serde(rename = "durationSecs")]
        duration_secs: f64,
    },
    Cancelled,
    Error {
        message: String,
    },
}

// Control values a command can set on a running recorder.
const RUN: u8 = 0;
const SAVE: u8 = 1;
const DISCARD: u8 = 2;

/// Recordings buffer in memory; cap the clip so a forgotten recorder can't
/// grow unbounded (10 min of 16 kHz f32 ≈ 38 MB). Hitting the cap saves.
const MAX_CLIP_SECS: usize = 600;

/// Running bench recorders by id, controllable from any command.
#[derive(Default)]
pub struct RecorderRegistry {
    next_id: AtomicU32,
    controls: Mutex<HashMap<u32, Arc<AtomicU8>>>,
}

impl RecorderRegistry {
    fn register(&self) -> (u32, Arc<AtomicU8>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let flag = Arc::new(AtomicU8::new(RUN));
        self.controls.lock().unwrap().insert(id, flag.clone());
        (id, flag)
    }

    fn signal(&self, id: u32, value: u8) -> bool {
        match self.controls.lock().unwrap().remove(&id) {
            Some(flag) => {
                flag.store(value, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// Stop capturing and save the clip; the path arrives as a Saved event.
    pub fn stop(&self, id: u32) -> bool {
        self.signal(id, SAVE)
    }

    /// Stop capturing and discard the clip.
    pub fn cancel(&self, id: u32) -> bool {
        self.signal(id, DISCARD)
    }

    fn forget(&self, id: u32) {
        self.controls.lock().unwrap().remove(&id);
    }
}

/// Start recording the mic to a 16 kHz mono wav at `out_path` on a dedicated
/// thread. Returns the recorder id immediately; readiness/errors/save results
/// arrive as events.
pub fn start_recorder(
    registry: &Arc<RecorderRegistry>,
    out_path: PathBuf,
    input_device: Option<String>,
    channel: Channel<RecorderEvent>,
) -> u32 {
    let (id, control) = registry.register();
    let registry = registry.clone();

    std::thread::Builder::new()
        .name(format!("recorder-{id}"))
        .spawn(move || {
            run_recorder(out_path, input_device, channel, control);
            registry.forget(id);
        })
        .expect("failed to spawn recorder thread");

    id
}

fn run_recorder(
    out_path: PathBuf,
    input_device: Option<String>,
    channel: Channel<RecorderEvent>,
    control: Arc<AtomicU8>,
) {
    let send = |event: RecorderEvent| {
        let _ = channel.send(event);
    };

    let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
    let capture = match AudioCapture::start(tx, input_device.as_deref()) {
        Ok(c) => c,
        Err(e) => return send(RecorderEvent::Error { message: e }),
    };

    send(RecorderEvent::Ready {
        device: capture.device_name.clone(),
        input_rate: capture.input_rate,
    });

    let max_samples = MAX_CLIP_SECS * TARGET_SAMPLE_RATE as usize;
    let mut clip: Vec<f32> = Vec::new();
    let mut last_level = std::time::Instant::now();
    let mut verdict = loop {
        match control.load(Ordering::Relaxed) {
            RUN => {}
            other => break other,
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(samples) => {
                if last_level.elapsed() >= LEVEL_INTERVAL {
                    last_level = std::time::Instant::now();
                    let (rms, peak) = level_of(&samples);
                    send(RecorderEvent::Level { rms, peak });
                }
                clip.extend_from_slice(&samples);
                if clip.len() >= max_samples {
                    break SAVE;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                send(RecorderEvent::Error {
                    message: "audio capture stopped unexpectedly".into(),
                });
                break DISCARD;
            }
        }
    };
    capture.stop();

    if verdict == SAVE && clip.is_empty() {
        verdict = DISCARD;
    }
    if verdict != SAVE {
        return send(RecorderEvent::Cancelled);
    }

    if let Some(parent) = out_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return send(RecorderEvent::Error {
                message: format!("failed to create {}: {e}", parent.display()),
            });
        }
    }
    let path = out_path.to_string_lossy().into_owned();
    if !sherpa_onnx::write(&path, &clip, TARGET_SAMPLE_RATE as i32) {
        return send(RecorderEvent::Error {
            message: format!("failed to write wav to {path}"),
        });
    }
    send(RecorderEvent::Saved {
        path,
        duration_secs: clip.len() as f64 / TARGET_SAMPLE_RATE as f64,
    });
}
