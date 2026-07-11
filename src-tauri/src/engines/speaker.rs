use std::path::Path;

use sherpa_onnx::{
    SpeakerEmbeddingExtractor, SpeakerEmbeddingExtractorConfig, SpeakerEmbeddingManager,
};

use crate::audio::TARGET_SAMPLE_RATE;
use crate::registry;

/// Speaker embedding extractor (catalog task "speaker-embedding", spec §2.3).
/// One loaded instance is shared via the EngineManager; identification,
/// verification, and (later) M3 People enrollment all run through it.
pub struct SpeakerEmbedder {
    extractor: SpeakerEmbeddingExtractor,
}

impl SpeakerEmbedder {
    /// `model_dir` = registry layout: a single 3D-Speaker/WeSpeaker .onnx.
    pub fn new(model_dir: &Path, num_threads: i32) -> Result<Self, String> {
        let model = registry::find_file(model_dir, "", ".onnx")
            .ok_or_else(|| format!("no speaker embedding .onnx in {}", model_dir.display()))?;

        let config = SpeakerEmbeddingExtractorConfig {
            model: Some(model.to_string_lossy().into_owned()),
            num_threads,
            ..Default::default()
        };
        let extractor = SpeakerEmbeddingExtractor::create(&config).ok_or_else(|| {
            format!("failed to load speaker embedding model {}", model.display())
        })?;
        Ok(Self { extractor })
    }

    pub fn dim(&self) -> usize {
        self.extractor.dim() as usize
    }

    /// Compute one embedding for a whole 16 kHz mono clip.
    pub fn embed(&self, samples: &[f32]) -> Result<Vec<f32>, String> {
        let stream = self
            .extractor
            .create_stream()
            .ok_or("failed to create speaker embedding stream")?;
        stream.accept_waveform(TARGET_SAMPLE_RATE as i32, samples);
        stream.input_finished();
        if !self.extractor.is_ready(&stream) {
            return Err("clip too short for a speaker embedding — record at least ~1 s".into());
        }
        self.extractor
            .compute(&stream)
            .ok_or_else(|| "failed to compute speaker embedding".into())
    }

    /// Build an in-memory search index over named embeddings (identification).
    pub fn manager(&self) -> Result<SpeakerEmbeddingManager, String> {
        SpeakerEmbeddingManager::create(self.extractor.dim())
            .ok_or_else(|| "failed to create speaker embedding manager".into())
    }
}

/// Cosine similarity between two embeddings, in [-1, 1]. Zero-length or
/// zero-norm inputs score 0 rather than dividing by zero.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for (x, y) in a.iter().zip(b) {
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom <= f32::EPSILON {
        return 0.0;
    }
    dot / denom
}

#[cfg(test)]
mod tests {
    use super::cosine_similarity;

    #[test]
    fn cosine_of_identical_vectors_is_one() {
        let v = vec![0.3, -1.2, 0.8, 4.0];
        assert!((cosine_similarity(&v, &v) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_of_orthogonal_vectors_is_zero() {
        assert!(cosine_similarity(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }

    #[test]
    fn cosine_of_opposite_vectors_is_minus_one() {
        let a = [1.0, -2.0, 3.0];
        let b = [-1.0, 2.0, -3.0];
        assert!((cosine_similarity(&a, &b) + 1.0).abs() < 1e-6);
    }

    #[test]
    fn degenerate_inputs_score_zero() {
        assert_eq!(cosine_similarity(&[], &[]), 0.0);
        assert_eq!(cosine_similarity(&[1.0], &[1.0, 2.0]), 0.0);
        assert_eq!(cosine_similarity(&[0.0, 0.0], &[1.0, 1.0]), 0.0);
    }
}
