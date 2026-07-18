use std::path::Path;

use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsModelConfig,
    OfflineTtsZipvoiceModelConfig,
};

use crate::registry;

// ZipVoice hyperparameters: the sherpa C++ defaults. The Rust crate's
// `Default` zeroes these (which would disable classifier-free guidance and
// mis-scale features), so they must be set explicitly.
const FEAT_SCALE: f32 = 0.1;
const T_SHIFT: f32 = 0.5;
const TARGET_RMS: f32 = 0.1;
const GUIDANCE_SCALE: f32 = 1.0;

/// Flow-matching sampling steps. The distill model is tuned for few-step
/// sampling; the spike A/B'd 4 vs 8 — 8 doubles synth time for marginal gain.
pub const CLONE_TTS_DEFAULT_STEPS: i32 = 4;

/// Local zero-shot voice cloning via ZipVoice (spec §2.4, M5 item 2). Batch
/// synthesis only — cloned-voice chat runs sentence-chunked through the M4
/// playback queue, never streaming (spec §9). zh/en only: no French (§7.1).
pub struct CloneTtsEngine {
    tts: OfflineTts,
}

impl CloneTtsEngine {
    /// Load the ZipVoice layout: encoder/decoder .onnx + vocoder (vocos) +
    /// tokens.txt, with espeak-ng-data (en) and lexicon.txt (zh) alongside.
    pub fn new(model_dir: &Path, num_threads: i32) -> Result<Self, String> {
        let tokens = model_dir.join("tokens.txt");
        if !tokens.exists() {
            return Err(format!("tokens.txt not found in {}", model_dir.display()));
        }
        let encoder = registry::find_file(model_dir, "encoder", ".onnx")
            .ok_or_else(|| format!("no encoder .onnx in {}", model_dir.display()))?;
        let decoder = registry::find_file(model_dir, "decoder", ".onnx")
            .ok_or_else(|| format!("no decoder .onnx in {}", model_dir.display()))?;
        let vocoder = registry::find_file(model_dir, "vocos", ".onnx")
            .or_else(|| registry::find_file(model_dir, "vocoder", ".onnx"))
            .ok_or_else(|| format!("no vocoder .onnx in {}", model_dir.display()))?;

        // English phonemization needs espeak-ng-data; the zh half reads
        // lexicon.txt. Pass whichever ship with the model.
        let data_dir = Some(model_dir.join("espeak-ng-data"))
            .filter(|d| d.exists())
            .map(|d| d.to_string_lossy().into_owned());
        let lexicon = Some(model_dir.join("lexicon.txt"))
            .filter(|f| f.exists())
            .map(|f| f.to_string_lossy().into_owned());

        let config = OfflineTtsConfig {
            model: OfflineTtsModelConfig {
                zipvoice: OfflineTtsZipvoiceModelConfig {
                    tokens: Some(tokens.to_string_lossy().into_owned()),
                    encoder: Some(encoder.to_string_lossy().into_owned()),
                    decoder: Some(decoder.to_string_lossy().into_owned()),
                    vocoder: Some(vocoder.to_string_lossy().into_owned()),
                    data_dir,
                    lexicon,
                    feat_scale: FEAT_SCALE,
                    t_shift: T_SHIFT,
                    target_rms: TARGET_RMS,
                    guidance_scale: GUIDANCE_SCALE,
                },
                num_threads,
                provider: Some("cpu".into()),
                debug: false,
                ..Default::default()
            },
            max_num_sentences: 1,
            ..Default::default()
        };

        let tts = OfflineTts::create(&config)
            .ok_or_else(|| format!("failed to load ZipVoice model {}", model_dir.display()))?;
        Ok(Self { tts })
    }

    /// Clone-synthesize `text` in the voice of the reference clip and write a
    /// wav; returns duration in seconds. ZipVoice conditions on the pair
    /// (reference audio, its exact transcript) — a mismatched transcript
    /// degrades similarity, which is why the clone-ref flow makes the user
    /// verify it (M5 item 1).
    #[allow(clippy::too_many_arguments)]
    pub fn synthesize_to_wav(
        &self,
        text: &str,
        ref_samples: &[f32],
        ref_sample_rate: i32,
        ref_text: &str,
        speed: f32,
        num_steps: i32,
        out_path: &Path,
    ) -> Result<f64, String> {
        if ref_samples.is_empty() {
            return Err("reference audio is empty".into());
        }
        if ref_text.trim().is_empty() {
            return Err("reference transcript is empty".into());
        }
        let config = GenerationConfig {
            speed,
            num_steps,
            reference_audio: Some(ref_samples.to_vec()),
            reference_sample_rate: ref_sample_rate,
            reference_text: Some(ref_text.to_string()),
            ..Default::default()
        };
        let audio = self
            .tts
            .generate_with_config(text, &config, None::<fn(&[f32], f32) -> bool>)
            .ok_or("zipvoice generation failed")?;
        if audio.samples().is_empty() {
            return Err("zipvoice produced no audio".into());
        }

        let out = out_path.to_string_lossy();
        if !audio.save(&out) {
            return Err(format!("failed to write wav to {out}"));
        }
        Ok(audio.samples().len() as f64 / audio.sample_rate() as f64)
    }
}
