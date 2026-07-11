use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;

use super::{downmix_to_mono, LinearResampler, TARGET_SAMPLE_RATE};

/// One row of the Settings → Audio device picker.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDeviceInfo {
    pub name: String,
    pub is_default: bool,
    pub sample_rate: u32,
}

/// Enumerate capture devices for the settings UI.
pub fn list_input_devices() -> Result<Vec<InputDeviceInfo>, String> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|device| device.name().ok());
    let devices = host
        .input_devices()
        .map_err(|e| format!("failed to enumerate input devices: {e}"))?;

    Ok(devices
        .filter_map(|device| {
            let name = device.name().ok()?;
            let sample_rate = device.default_input_config().ok()?.sample_rate().0;
            Some(InputDeviceInfo {
                is_default: default_name.as_deref() == Some(&name),
                name,
                sample_rate,
            })
        })
        .collect())
}

/// The device a capture should open: the preferred name when it's present,
/// otherwise the system default. A stale preference (device unplugged) falls
/// back to the default rather than failing the pipeline.
fn select_input_device(host: &cpal::Host, preferred: Option<&str>) -> Result<cpal::Device, String> {
    if let Some(name) = preferred {
        let found = host
            .input_devices()
            .map_err(|e| format!("failed to enumerate input devices: {e}"))?
            .find(|device| device.name().is_ok_and(|n| n == name));
        match found {
            Some(device) => return Ok(device),
            None => log::warn!("[audio] preferred input '{name}' not found; using default"),
        }
    }
    host.default_input_device()
        .ok_or_else(|| "no default input device — check microphone permission".into())
}

/// Live mic capture: default input device → mono 16 kHz f32 chunks on `tx`.
///
/// cpal's Stream is !Send on macOS, so the handle must be created and kept on
/// the thread that owns the pipeline; audio callbacks arrive on cpal's own
/// realtime thread and only touch the resampler + channel sender.
pub struct AudioCapture {
    stream: cpal::Stream,
    pub input_rate: u32,
    pub device_name: String,
    /// Set by cpal's error callback (e.g. the device was unplugged). cpal
    /// keeps the data-callback's `Sender` clone alive even after a stream
    /// error, so `mpsc::RecvTimeoutError::Disconnected` never fires on device
    /// loss — pipelines must poll this flag instead to notice the capture died.
    pub stream_error: Arc<AtomicBool>,
}

impl AudioCapture {
    pub fn start(tx: Sender<Vec<f32>>, preferred_device: Option<&str>) -> Result<Self, String> {
        let host = cpal::default_host();
        let device = select_input_device(&host, preferred_device)?;
        let device_name = device.name().unwrap_or_else(|_| "unknown".into());

        let config = device
            .default_input_config()
            .map_err(|e| format!("no default input config: {e}"))?;
        let input_rate = config.sample_rate().0;
        let channels = config.channels();

        let mut resampler = LinearResampler::new(input_rate, TARGET_SAMPLE_RATE);
        let stream_error = Arc::new(AtomicBool::new(false));
        let error_flag = stream_error.clone();

        let stream = device
            .build_input_stream(
                &config.into(),
                move |data: &[f32], _| {
                    let mono = downmix_to_mono(data, channels);
                    let resampled = resampler.process(&mono);
                    if !resampled.is_empty() {
                        // Receiver gone = pipeline stopped; nothing to do.
                        let _ = tx.send(resampled);
                    }
                },
                move |err| {
                    log::error!("[audio] input stream error: {err}");
                    error_flag.store(true, Ordering::Relaxed);
                },
                None,
            )
            .map_err(|e| format!("failed to build input stream: {e}"))?;

        stream
            .play()
            .map_err(|e| format!("failed to start input stream: {e}"))?;

        Ok(Self {
            stream,
            input_rate,
            device_name,
            stream_error,
        })
    }

    pub fn stop(self) {
        // Dropping the stream stops capture; pause first for symmetry.
        let _ = self.stream.pause();
    }
}
