use std::path::Path;

use serde::Serialize;
use sherpa_onnx::{
    FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
    OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig,
    SpeakerEmbeddingExtractorConfig,
};

use crate::registry;

/// Clustering knobs surfaced by the diarization playground tool (spec §2.3).
#[derive(Clone, Copy)]
pub struct DiarizationParams {
    /// Known speaker count; None clusters by `threshold` instead.
    pub num_speakers: Option<i32>,
    /// Cosine-distance clustering threshold — smaller splits more speakers.
    pub threshold: f32,
}

impl Default for DiarizationParams {
    fn default() -> Self {
        Self {
            num_speakers: None,
            threshold: 0.5,
        }
    }
}

/// One diarized span labeled with a clustered speaker index.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarizationSegment {
    pub start: f32,
    pub end: f32,
    pub speaker: i32,
}

fn build_config(
    segmentation_model: &Path,
    embedding_model: &Path,
    num_threads: i32,
    params: DiarizationParams,
) -> OfflineSpeakerDiarizationConfig {
    OfflineSpeakerDiarizationConfig {
        segmentation: OfflineSpeakerSegmentationModelConfig {
            pyannote: OfflineSpeakerSegmentationPyannoteModelConfig {
                model: Some(segmentation_model.to_string_lossy().into_owned()),
                ..Default::default()
            },
            num_threads,
            ..Default::default()
        },
        embedding: SpeakerEmbeddingExtractorConfig {
            model: Some(embedding_model.to_string_lossy().into_owned()),
            num_threads,
            ..Default::default()
        },
        clustering: FastClusteringConfig {
            num_clusters: params.num_speakers.unwrap_or(-1),
            threshold: params.threshold,
            ..Default::default()
        },
        ..Default::default()
    }
}

/// Offline speaker diarization: pyannote segmentation + speaker embeddings +
/// fast clustering (catalog tasks "diarization" + "speaker-embedding").
/// Loading is the expensive part; clustering params are swapped per run via
/// `set_config`, so one cached instance serves every threshold/count.
pub struct Diarizer {
    diarizer: OfflineSpeakerDiarization,
    segmentation_model: std::path::PathBuf,
    embedding_model: std::path::PathBuf,
    num_threads: i32,
}

impl Diarizer {
    /// `segmentation_dir` = pyannote release layout (model.onnx / model.int8.onnx);
    /// `embedding_dir` = a single speaker embedding .onnx.
    pub fn new(
        segmentation_dir: &Path,
        embedding_dir: &Path,
        num_threads: i32,
    ) -> Result<Self, String> {
        let segmentation_model = registry::find_file(segmentation_dir, "model", ".onnx")
            .ok_or_else(|| format!("no segmentation .onnx in {}", segmentation_dir.display()))?;
        let embedding_model = registry::find_file(embedding_dir, "", ".onnx")
            .ok_or_else(|| format!("no speaker embedding .onnx in {}", embedding_dir.display()))?;

        let config = build_config(
            &segmentation_model,
            &embedding_model,
            num_threads,
            DiarizationParams::default(),
        );
        let diarizer = OfflineSpeakerDiarization::create(&config).ok_or_else(|| {
            format!(
                "failed to load diarization models {} + {}",
                segmentation_model.display(),
                embedding_model.display()
            )
        })?;
        Ok(Self {
            diarizer,
            segmentation_model,
            embedding_model,
            num_threads,
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.diarizer.sample_rate() as u32
    }

    /// Diarize a whole clip (at `sample_rate()`), returning segments sorted by
    /// start time plus the estimated speaker count.
    pub fn diarize(
        &self,
        samples: &[f32],
        params: DiarizationParams,
    ) -> Result<(Vec<DiarizationSegment>, i32), String> {
        self.diarizer.set_config(&build_config(
            &self.segmentation_model,
            &self.embedding_model,
            self.num_threads,
            params,
        ));
        let result = self
            .diarizer
            .process(samples)
            .ok_or("diarization failed — clip may be empty or too short")?;
        let segments: Vec<DiarizationSegment> = result
            .sort_by_start_time()
            .into_iter()
            .map(|s| DiarizationSegment {
                start: s.start,
                end: s.end,
                speaker: s.speaker,
            })
            .collect();
        // Count distinct labels rather than trusting result.num_speakers(),
        // which can disagree with the emitted labels on short clips.
        let mut labels: Vec<i32> = segments.iter().map(|s| s.speaker).collect();
        labels.sort_unstable();
        labels.dedup();
        Ok((segments, labels.len() as i32))
    }
}
