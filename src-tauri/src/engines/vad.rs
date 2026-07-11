use std::path::Path;

use serde::Serialize;
use sherpa_onnx::{SileroVadModelConfig, VadModelConfig, VoiceActivityDetector};

/// Tunable Silero knobs surfaced by the playground param panel (spec §2.3).
/// Defaults match what dictation has shipped with since M1.
#[derive(Clone, Copy)]
pub struct VadParams {
    pub threshold: f32,
    pub min_silence: f32,
    pub min_speech: f32,
}

impl Default for VadParams {
    fn default() -> Self {
        Self {
            threshold: 0.5,
            min_silence: 0.5,
            min_speech: 0.25,
        }
    }
}

fn create_vad(model_path: &Path, params: VadParams) -> Result<VoiceActivityDetector, String> {
    let config = VadModelConfig {
        silero_vad: SileroVadModelConfig {
            model: Some(model_path.to_string_lossy().into_owned()),
            threshold: params.threshold,
            min_silence_duration: params.min_silence,
            min_speech_duration: params.min_speech,
            max_speech_duration: 30.0,
            window_size: VAD_WINDOW as i32,
        },
        sample_rate: crate::audio::TARGET_SAMPLE_RATE as i32,
        num_threads: 1,
        provider: Some("cpu".into()),
        debug: false,
        ..Default::default()
    };
    VoiceActivityDetector::create(&config, 60.0)
        .ok_or_else(|| format!("failed to load VAD model {}", model_path.display()))
}

/// Silero VAD wrapper. Feed 16 kHz mono frames; emits speaking-state changes.
///
/// Silero v5 processes fixed 512-sample windows at 16 kHz (32 ms); callers can
/// push arbitrary chunk sizes — buffering happens here.
pub struct SpeechDetector {
    vad: VoiceActivityDetector,
    buffer: Vec<f32>,
    speaking: bool,
}

pub const VAD_WINDOW: usize = 512;

impl SpeechDetector {
    pub fn new(model_path: &Path) -> Result<Self, String> {
        Self::with_params(model_path, VadParams::default())
    }

    pub fn with_params(model_path: &Path, params: VadParams) -> Result<Self, String> {
        let vad = create_vad(model_path, params)?;
        Ok(Self {
            vad,
            buffer: Vec::with_capacity(VAD_WINDOW * 4),
            speaking: false,
        })
    }

    /// Push samples; returns Some(new_state) when the speaking state flips.
    pub fn push(&mut self, samples: &[f32]) -> Option<bool> {
        self.buffer.extend_from_slice(samples);
        let mut flipped = None;
        while self.buffer.len() >= VAD_WINDOW {
            let window: Vec<f32> = self.buffer.drain(..VAD_WINDOW).collect();
            self.vad.accept_waveform(&window);
            let now_speaking = self.vad.detected();
            if now_speaking != self.speaking {
                self.speaking = now_speaking;
                flipped = Some(now_speaking);
            }
            // Drain finished segments we don't consume (segment audio comes
            // from the recognizer path) to keep the VAD queue bounded.
            while !self.vad.is_empty() {
                self.vad.pop();
            }
        }
        flipped
    }

    pub fn is_speaking(&self) -> bool {
        self.speaking
    }
}

/// One detected speech span, in seconds from the start of the audio.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechSpan {
    pub start: f32,
    pub end: f32,
}

/// Offline VAD: run Silero over a whole 16 kHz mono clip and return the
/// detected speech spans. Segments are drained as they complete so the
/// detector's 60 s circular buffer never overflows on long files.
pub fn detect_speech_spans(
    model_path: &Path,
    samples: &[f32],
    params: VadParams,
) -> Result<Vec<SpeechSpan>, String> {
    let vad = create_vad(model_path, params)?;
    let rate = crate::audio::TARGET_SAMPLE_RATE as f32;
    let mut spans = Vec::new();

    let mut drain = |vad: &VoiceActivityDetector| {
        while !vad.is_empty() {
            if let Some(segment) = vad.front() {
                let start = segment.start() as f32 / rate;
                spans.push(SpeechSpan {
                    start,
                    end: start + segment.n() as f32 / rate,
                });
            }
            vad.pop();
        }
    };

    for window in samples.chunks(VAD_WINDOW) {
        // Silero consumes fixed 512-sample windows; the final short chunk is
        // covered by flush() below.
        if window.len() < VAD_WINDOW {
            break;
        }
        vad.accept_waveform(window);
        drain(&vad);
    }
    vad.flush();
    drain(&vad);

    Ok(spans)
}
