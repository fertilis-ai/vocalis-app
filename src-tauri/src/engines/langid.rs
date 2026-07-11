use std::path::Path;

use sherpa_onnx::{
    SpokenLanguageIdentification, SpokenLanguageIdentificationConfig,
    SpokenLanguageIdentificationWhisperConfig,
};

use crate::registry::find_file;

/// Spoken language identification via sherpa's multilingual Whisper
/// encoder/decoder pair (catalog task "lang-id"). Offline, one clip at a time.
///
/// The sherpa API returns a single top language code (no per-language score
/// distribution is exposed), so the tool renders one detection rather than a
/// top-5 table — documented in the playground page.
pub struct LangIdentifier {
    slid: SpokenLanguageIdentification,
}

impl LangIdentifier {
    /// `model_dir` is a whisper release layout (encoder/decoder .onnx; int8
    /// preferred — find_file's sort puts `.int8.onnx` before `.onnx`).
    pub fn new(model_dir: &Path, num_threads: i32) -> Result<Self, String> {
        let missing = |what: &str| format!("{what} not found in {}", model_dir.display());
        let encoder = find_file(model_dir, "encoder", ".onnx").ok_or_else(|| missing("encoder"))?;
        let decoder = find_file(model_dir, "decoder", ".onnx").ok_or_else(|| missing("decoder"))?;

        let config = SpokenLanguageIdentificationConfig {
            whisper: SpokenLanguageIdentificationWhisperConfig {
                encoder: Some(encoder.to_string_lossy().into_owned()),
                decoder: Some(decoder.to_string_lossy().into_owned()),
                tail_paddings: 0,
            },
            num_threads,
            debug: false,
            provider: Some("cpu".into()),
        };
        let slid = SpokenLanguageIdentification::create(&config)
            .ok_or_else(|| format!("failed to load language-ID model {}", model_dir.display()))?;
        Ok(Self { slid })
    }

    /// Identify the language of a 16 kHz mono clip. Returns the ISO 639-1 code
    /// (e.g. "en", "fr") whisper reports for the dominant language.
    pub fn identify(&self, samples: &[f32]) -> Result<String, String> {
        let stream = self.slid.create_stream();
        stream.accept_waveform(crate::audio::TARGET_SAMPLE_RATE as i32, samples);
        self.slid
            .compute(&stream)
            .map(|result| result.lang)
            .ok_or_else(|| "language identification produced no result".into())
    }
}
