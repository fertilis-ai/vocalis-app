use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::ipc::Channel;

use crate::audio::TARGET_SAMPLE_RATE;
use crate::commands::speech::read_wav_16k;
use crate::engines::{DiarizationParams, Diarizer, OfflineAsr, Punctuator, SpeakerEmbedder};
use crate::pipeline::{
    cluster_means_to_people, letter_label, relabel_by_first_appearance, transcribe_chunks,
    DropGuard, EnrolledSpeaker, PipelineEvent, PipelineRegistry, SessionSegment,
    MAX_ASR_CHUNK_SAMPLES,
};

// The file-import pipeline (spec §2.2B, M3 item 4). Unlike the live session
// (mic → streaming ASR → online labels → stop-time refine), import is a batch
// job over a normalized wav (`sessions/<id>/audio.wav`, written by the
// `import_audio` command): diarize the whole clip, then batch-transcribe each
// diarization span, punctuate, embed, and match enrolled people. It streams the
// same events the live pipeline does — `SpeakerTurn` per turn, `Progress` for
// the meter, then a settled `Refined` + `Stopped` — so the session UI (item 5)
// renders live and imported transcripts through one handler. Chunked decode +
// word-timestamp stitching is shared with the other batch-ASR pipelines via
// `pipeline::vad_batch`.

pub struct ImportModels {
    /// Batch (offline whisper) ASR model dir.
    pub asr_dir: PathBuf,
    pub punctuation_dir: PathBuf,
    pub speaker_dir: PathBuf,
    pub diar_segmentation_dir: PathBuf,
    pub diar_embedding_dir: PathBuf,
    pub num_threads: i32,
    /// Session directory holding the normalized `audio.wav` to import.
    pub session_dir: PathBuf,
    /// Whisper language code ("en", "fr"); None = auto-detect.
    pub language: Option<String>,
    /// Enrolled people to match refined clusters against.
    pub enrolled: Vec<EnrolledSpeaker>,
    /// Cosine threshold for matching an enrolled Person.
    pub match_threshold: f32,
}

/// Start a file import on its own thread. `active` guards against a concurrent
/// import/session and is cleared when the thread exits. Registers its model
/// paths with the registry so the deletion guard protects them.
pub fn start_import(
    registry: &PipelineRegistry,
    active: Arc<AtomicBool>,
    models: ImportModels,
    channel: Channel<PipelineEvent>,
) -> u32 {
    let paths = vec![
        models.asr_dir.clone(),
        models.punctuation_dir.clone(),
        models.speaker_dir.clone(),
        models.diar_segmentation_dir.clone(),
        models.diar_embedding_dir.clone(),
    ];
    let (id, stop) = registry.register(paths);
    let thread_registry = registry.clone();

    std::thread::Builder::new()
        .name(format!("import-{id}"))
        .spawn(move || {
            let _finish = DropGuard::new(|| {
                active.store(false, Ordering::SeqCst);
                thread_registry.finish(id);
            });
            run_import(models, channel, stop);
        })
        .expect("failed to spawn import thread");

    id
}

/// An imported span: its final text/span plus the embedding of its audio, kept
/// so the settle pass can re-match clusters to enrolled people by mean.
struct ImportedSegment {
    text: String,
    start_ms: f64,
    end_ms: f64,
    /// Cluster index from the whole-clip diarization (pre-settle).
    cluster: usize,
    embedding: Option<Vec<f32>>,
}

fn run_import(models: ImportModels, channel: Channel<PipelineEvent>, stop: Arc<AtomicBool>) {
    let send = |event: PipelineEvent| {
        let _ = channel.send(event);
    };

    let audio_path = models.session_dir.join("audio.wav");
    let samples = match read_wav_16k(&audio_path.to_string_lossy()) {
        Ok(s) => s,
        Err(message) => return send(PipelineEvent::Error { message }),
    };

    // Load every engine up front; a load failure is an actionable import error.
    let asr = match OfflineAsr::new(&models.asr_dir, models.num_threads, models.language.as_deref())
    {
        Ok(a) => a,
        Err(message) => return send(PipelineEvent::Error { message }),
    };
    let punctuator = match Punctuator::new(&models.punctuation_dir, models.num_threads) {
        Ok(p) => p,
        Err(message) => return send(PipelineEvent::Error { message }),
    };
    let embedder = match SpeakerEmbedder::new(&models.speaker_dir, models.num_threads) {
        Ok(e) => e,
        Err(message) => return send(PipelineEvent::Error { message }),
    };
    let diarizer = match Diarizer::new(
        &models.diar_segmentation_dir,
        &models.diar_embedding_dir,
        models.num_threads,
    ) {
        Ok(d) => d,
        Err(message) => return send(PipelineEvent::Error { message }),
    };

    send(PipelineEvent::Processing {
        message: "identifying speakers".into(),
    });
    let diar = match diarizer.diarize(&samples, DiarizationParams::default()) {
        Ok((segments, _)) => segments,
        Err(message) => return send(PipelineEvent::Error { message }),
    };
    if diar.is_empty() {
        // No speech detected — settle to an empty transcript rather than erroring.
        send(PipelineEvent::Refined { segments: Vec::new() });
        return send(PipelineEvent::Stopped);
    }

    let clusters = relabel_by_first_appearance(&diar.iter().map(|d| d.speaker).collect::<Vec<_>>());
    let total_secs: f64 = diar.iter().map(|d| (d.end - d.start).max(0.0) as f64).sum();
    let mut done_secs = 0.0f64;
    let mut imported: Vec<ImportedSegment> = Vec::new();

    send(PipelineEvent::Processing {
        message: "transcribing".into(),
    });
    for (span, &cluster) in diar.iter().zip(clusters.iter()) {
        if stop.load(Ordering::Relaxed) {
            // Cancelled mid-run: stop without a settled transcript.
            return send(PipelineEvent::Cancelled);
        }
        let span_secs = (span.end - span.start).max(0.0) as f64;
        let start_sample = ((span.start as f64) * TARGET_SAMPLE_RATE as f64) as usize;
        let end_sample = (((span.end as f64) * TARGET_SAMPLE_RATE as f64) as usize).min(samples.len());

        let text = match transcribe_chunks(&samples[start_sample..end_sample], MAX_ASR_CHUNK_SAMPLES, &stop, |chunk| {
            asr.transcribe(chunk)
        }) {
            Ok(Some(t)) => t.text,
            Ok(None) => return send(PipelineEvent::Cancelled),
            Err(message) => return send(PipelineEvent::Error { message }),
        };
        let text = punctuator.punctuate_if_needed(&text);

        done_secs += span_secs;
        if text.trim().is_empty() {
            send(PipelineEvent::Progress {
                fraction: progress_fraction(done_secs, total_secs),
            });
            continue;
        }

        let embedding = embedder.embed(&samples[start_sample..end_sample]).ok();
        let person_id = embedding
            .as_ref()
            .and_then(|emb| crate::pipeline::match_person(&models.enrolled, emb, models.match_threshold));
        let start_ms = span.start as f64 * 1000.0;
        let end_ms = span.end as f64 * 1000.0;

        send(PipelineEvent::SpeakerTurn {
            segment: SessionSegment {
                text: text.clone(),
                start_ms,
                end_ms,
                speaker_label: letter_label(cluster),
                person_id: person_id.clone(),
            },
        });
        imported.push(ImportedSegment {
            text,
            start_ms,
            end_ms,
            cluster,
            embedding,
        });
        send(PipelineEvent::Progress {
            fraction: progress_fraction(done_secs, total_secs),
        });
    }

    send(PipelineEvent::Refined {
        segments: settle(&imported, &models.enrolled, models.match_threshold),
    });
    send(PipelineEvent::Stopped);
}

/// Settle the imported segments: renumber clusters by first appearance (so the
/// first speaker is "A") and re-match each cluster to an enrolled person from
/// its segments' mean embedding.
fn settle(
    imported: &[ImportedSegment],
    enrolled: &[EnrolledSpeaker],
    match_threshold: f32,
) -> Vec<SessionSegment> {
    let raw: Vec<i32> = imported.iter().map(|s| s.cluster as i32).collect();
    let clusters = relabel_by_first_appearance(&raw);
    let embeddings: Vec<Option<Vec<f32>>> = imported.iter().map(|s| s.embedding.clone()).collect();
    let person_for_cluster = cluster_means_to_people(&clusters, &embeddings, enrolled, match_threshold);

    imported
        .iter()
        .zip(clusters.iter())
        .map(|(seg, &cluster)| SessionSegment {
            text: seg.text.clone(),
            start_ms: seg.start_ms,
            end_ms: seg.end_ms,
            speaker_label: letter_label(cluster),
            person_id: person_for_cluster.get(cluster).cloned().flatten(),
        })
        .collect()
}

// ── Pure algorithmic core (unit-tested) ─────────────────────────────────────

/// Fraction in [0,1], guarding a zero total (all-silence clips).
fn progress_fraction(done: f64, total: f64) -> f32 {
    if total <= 0.0 {
        return 1.0;
    }
    (done / total).clamp(0.0, 1.0) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_fraction_guards_zero_total() {
        assert_eq!(progress_fraction(0.0, 0.0), 1.0);
        assert_eq!(progress_fraction(5.0, 10.0), 0.5);
        assert_eq!(progress_fraction(20.0, 10.0), 1.0);
    }

    #[test]
    fn settle_renumbers_clusters_by_first_appearance() {
        // Diarization labeled spans 2, 2, 5 → settle to A, A, B.
        let imported = vec![
            ImportedSegment { text: "one".into(), start_ms: 0.0, end_ms: 1000.0, cluster: 2, embedding: None },
            ImportedSegment { text: "two".into(), start_ms: 1000.0, end_ms: 2000.0, cluster: 2, embedding: None },
            ImportedSegment { text: "three".into(), start_ms: 2000.0, end_ms: 3000.0, cluster: 5, embedding: None },
        ];
        let out = settle(&imported, &[], 0.5);
        let labels: Vec<&str> = out.iter().map(|s| s.speaker_label.as_str()).collect();
        assert_eq!(labels, ["A", "A", "B"]);
        assert!(out.iter().all(|s| s.person_id.is_none()));
    }
}
