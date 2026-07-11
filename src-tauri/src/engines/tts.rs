use std::path::Path;

use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig,
    OfflineTtsModelConfig, OfflineTtsVitsModelConfig,
};

use crate::registry;

/// Local offline TTS (spec §3.3 `Tts`). One loaded instance is shared via the
/// EngineManager; synthesis writes wavs into the TTS cache. Two model families
/// ship as stock voices: Kokoro (multi-voice English) and VITS/Piper
/// (single-voice, e.g. the French SIWIS voice) — the layout on disk selects
/// which sherpa config to build.
pub struct TtsEngine {
    tts: OfflineTts,
}

impl TtsEngine {
    /// Load whichever TTS family lives in `model_dir`. Kokoro layout carries a
    /// `voices.bin`; a bare `*.onnx` + `tokens.txt` + `espeak-ng-data/` is VITS
    /// (Piper). Anything else is an error rather than a silent wrong load.
    pub fn new(model_dir: &Path, num_threads: i32) -> Result<Self, String> {
        let tokens = model_dir.join("tokens.txt");
        let data_dir = model_dir.join("espeak-ng-data");
        if !tokens.exists() {
            return Err(format!("tokens.txt not found in {}", model_dir.display()));
        }
        if !data_dir.exists() {
            return Err(format!(
                "espeak-ng-data/ not found in {}",
                model_dir.display()
            ));
        }

        let voices = model_dir.join("voices.bin");
        let model = if voices.exists() {
            // Kokoro layout ships a fixed model.onnx name.
            OfflineTtsModelConfig {
                kokoro: OfflineTtsKokoroModelConfig {
                    model: Some(require(model_dir.join("model.onnx"))?),
                    voices: Some(voices.to_string_lossy().into_owned()),
                    tokens: Some(tokens.to_string_lossy().into_owned()),
                    data_dir: Some(data_dir.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                num_threads,
                provider: Some("cpu".into()),
                debug: false,
                ..Default::default()
            }
        } else {
            // VITS/Piper: the acoustic model is a bare <name>.onnx (not the
            // vocoder/tokens), so pick the .onnx that isn't a known sidecar.
            let onnx = registry::find_file(model_dir, "", ".onnx")
                .ok_or_else(|| format!("no .onnx model found in {}", model_dir.display()))?;
            OfflineTtsModelConfig {
                vits: OfflineTtsVitsModelConfig {
                    model: Some(onnx.to_string_lossy().into_owned()),
                    tokens: Some(tokens.to_string_lossy().into_owned()),
                    data_dir: Some(data_dir.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                num_threads,
                provider: Some("cpu".into()),
                debug: false,
                ..Default::default()
            }
        };

        let config = OfflineTtsConfig {
            model,
            max_num_sentences: 1,
            ..Default::default()
        };

        let tts = OfflineTts::create(&config)
            .ok_or_else(|| format!("failed to load TTS model {}", model_dir.display()))?;
        Ok(Self { tts })
    }

    pub fn num_speakers(&self) -> i32 {
        self.tts.num_speakers()
    }

    /// Synthesize and write a wav; returns duration in seconds.
    pub fn synthesize_to_wav(
        &self,
        text: &str,
        speaker_id: i32,
        speed: f32,
        out_path: &Path,
    ) -> Result<f64, String> {
        let config = GenerationConfig {
            sid: speaker_id,
            speed,
            ..Default::default()
        };
        let audio = self
            .tts
            .generate_with_config(text, &config, None::<fn(&[f32], f32) -> bool>)
            .ok_or("tts generation failed")?;

        let out = out_path.to_string_lossy();
        if !audio.save(&out) {
            return Err(format!("failed to write wav to {out}"));
        }
        Ok(audio.samples().len() as f64 / audio.sample_rate() as f64)
    }
}

/// Require a file to exist, returning its path as a String for sherpa configs.
fn require(path: std::path::PathBuf) -> Result<String, String> {
    if path.exists() {
        Ok(path.to_string_lossy().into_owned())
    } else {
        Err(format!("{} not found", path.display()))
    }
}
