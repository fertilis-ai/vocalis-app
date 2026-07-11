use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use tauri::ipc::Channel;

use crate::audio::{AudioCapture, TARGET_SAMPLE_RATE};
use crate::engines::{
    cosine_similarity, DiarizationParams, Diarizer, Punctuator, SpeakerEmbedder, SpeechDetector,
    StreamingAsrSession,
};
use crate::pipeline::{
    accumulate, cluster_means_to_people, letter_label, match_person, relabel_by_first_appearance,
    level_of, DropGuard, EnrolledSpeaker, PipelineEvent, PipelineRegistry, SessionSegment,
    LEVEL_INTERVAL,
};

// The live transcription-session pipeline (spec §2.2B, M3 item 2). Like
// `dictation.rs`, one OS thread owns the cpal capture and every sherpa session;
// raw audio never crosses the IPC boundary. It differs from dictation in three
// ways: it retains the whole session to disk (for the scrubber), labels each
// turn with an online provisional speaker, and — on stop — runs an offline
// diarization refinement pass over the retained audio before settling labels.

pub struct SessionPipelineModels {
    pub asr_dir: PathBuf,
    pub vad_path: PathBuf,
    pub punctuation_dir: PathBuf,
    pub speaker_dir: PathBuf,
    /// Diarization segmentation + embedding model dirs, for the stop-time pass.
    pub diar_segmentation_dir: PathBuf,
    pub diar_embedding_dir: PathBuf,
    pub num_threads: i32,
    pub input_device: Option<String>,
    /// Directory to write `audio.wav` into when `audio_retained`.
    pub session_dir: PathBuf,
    pub audio_retained: bool,
    /// Enrolled people to match against (empty until M3 item 3 wires it).
    pub enrolled: Vec<EnrolledSpeaker>,
    /// Cosine threshold for joining an existing online cluster.
    pub cluster_threshold: f32,
    /// Cosine threshold for matching an enrolled Person.
    pub match_threshold: f32,
}

/// Start a live session pipeline on its own thread. `active` guards against a
/// second concurrent session and is cleared when the thread exits. Registers
/// its model paths with the registry so the deletion guard protects them.
pub fn start_session_pipeline(
    registry: &PipelineRegistry,
    active: Arc<AtomicBool>,
    models: SessionPipelineModels,
    channel: Channel<PipelineEvent>,
) -> u32 {
    let paths = vec![
        models.vad_path.clone(),
        models.asr_dir.clone(),
        models.punctuation_dir.clone(),
        models.speaker_dir.clone(),
        models.diar_segmentation_dir.clone(),
        models.diar_embedding_dir.clone(),
    ];
    let (id, stop) = registry.register(paths);
    let thread_registry = registry.clone();

    std::thread::Builder::new()
        .name(format!("session-pipeline-{id}"))
        .spawn(move || {
            let _finish = DropGuard::new(|| {
                active.store(false, Ordering::SeqCst);
                thread_registry.finish(id);
            });
            run_session_pipeline(models, channel, stop);
        })
        .expect("failed to spawn session pipeline thread");

    id
}

/// A segment accumulated during capture: text + span + the embedding of its
/// audio, kept so the stop-time pass can re-match clusters to enrolled people.
struct CapturedSegment {
    text: String,
    start_ms: f64,
    end_ms: f64,
    embedding: Option<Vec<f32>>,
    /// Online cluster index (pre-refinement).
    cluster: usize,
}

fn run_session_pipeline(
    models: SessionPipelineModels,
    channel: Channel<PipelineEvent>,
    stop: Arc<AtomicBool>,
) {
    let send = |event: PipelineEvent| {
        let _ = channel.send(event);
    };

    let mut vad = match SpeechDetector::new(&models.vad_path) {
        Ok(v) => v,
        Err(message) => return send(PipelineEvent::Error { message }),
    };
    let mut asr = match StreamingAsrSession::new(&models.asr_dir, models.num_threads) {
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

    let (audio_tx, audio_rx) = mpsc::channel::<Vec<f32>>();
    let capture = match AudioCapture::start(audio_tx, models.input_device.as_deref()) {
        Ok(c) => c,
        Err(message) => return send(PipelineEvent::Error { message }),
    };

    send(PipelineEvent::Ready {
        device: capture.device_name.clone(),
        input_rate: capture.input_rate,
    });

    let mut labeler = OnlineLabeler::new(
        models.cluster_threshold,
        models.match_threshold,
        models.enrolled.clone(),
    );
    let mut buffer: Vec<f32> = Vec::new();
    let mut seg_start_sample: usize = 0;
    let mut segments: Vec<CapturedSegment> = Vec::new();
    let mut last_level = Instant::now();

    while !stop.load(Ordering::Relaxed) && !capture.stream_error.load(Ordering::Relaxed) {
        match audio_rx.recv_timeout(Duration::from_millis(30)) {
            Ok(samples) => {
                buffer.extend_from_slice(&samples);
                if last_level.elapsed() >= LEVEL_INTERVAL {
                    last_level = Instant::now();
                    let (rms, peak) = level_of(&samples);
                    send(PipelineEvent::Level { rms, peak });
                }
                if let Some(speaking) = vad.push(&samples) {
                    send(PipelineEvent::VadState { speaking });
                }
                let decode_started = Instant::now();
                if let Some(text) = asr.push(&samples) {
                    send(PipelineEvent::Partial {
                        text,
                        latency_ms: decode_started.elapsed().as_secs_f32() * 1000.0,
                    });
                }
                if let Some(segment) = asr.take_final() {
                    emit_turn(
                        segment.text,
                        &buffer,
                        &mut seg_start_sample,
                        &punctuator,
                        &embedder,
                        &mut labeler,
                        &mut segments,
                        &send,
                    );
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            // cpal keeps the data-callback's Sender clone alive even after a
            // stream error, so this rarely fires on real device loss (the
            // stream_error flag above is what actually catches it) — treated
            // the same way regardless: fall through to the normal stop tail.
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    if capture.stream_error.load(Ordering::Relaxed) {
        send(PipelineEvent::Error {
            message: "audio input device disconnected; saving what was captured".into(),
        });
    }

    // Stop requested (or device lost): flush the ASR tail, then stop capture.
    if let Some(text) = asr.finish() {
        emit_turn(
            text,
            &buffer,
            &mut seg_start_sample,
            &punctuator,
            &embedder,
            &mut labeler,
            &mut segments,
            &send,
        );
    }
    capture.stop();

    if models.audio_retained {
        write_session_audio(&models.session_dir, &buffer, &send);
    }

    send(PipelineEvent::Processing {
        message: "refining speakers".into(),
    });
    let refined = refine(&models, &buffer, &segments, &labeler);
    send(PipelineEvent::Refined { segments: refined });
    send(PipelineEvent::Stopped);
}

/// Slice the current segment's audio, punctuate its text, embed + label it,
/// record it, and emit the provisional `SpeakerTurn`.
#[allow(clippy::too_many_arguments)]
fn emit_turn(
    raw_text: String,
    buffer: &[f32],
    seg_start_sample: &mut usize,
    punctuator: &Punctuator,
    embedder: &SpeakerEmbedder,
    labeler: &mut OnlineLabeler,
    segments: &mut Vec<CapturedSegment>,
    send: &dyn Fn(PipelineEvent),
) {
    let text = punctuator.punctuate(raw_text.trim());
    if text.trim().is_empty() {
        return;
    }
    let seg_end_sample = buffer.len();
    let slice = &buffer[(*seg_start_sample).min(seg_end_sample)..seg_end_sample];
    let embedding = embedder.embed(slice).ok();
    let (cluster, person_id) = match &embedding {
        Some(emb) => labeler.assign(emb),
        None => (labeler.new_cluster(), None),
    };
    let start_ms = samples_to_ms(*seg_start_sample);
    let end_ms = samples_to_ms(seg_end_sample);
    *seg_start_sample = seg_end_sample;

    segments.push(CapturedSegment {
        text: text.clone(),
        start_ms,
        end_ms,
        embedding,
        cluster,
    });
    send(PipelineEvent::SpeakerTurn {
        segment: SessionSegment {
            text,
            start_ms,
            end_ms,
            speaker_label: letter_label(cluster),
            person_id,
        },
    });
}

fn samples_to_ms(samples: usize) -> f64 {
    samples as f64 * 1000.0 / TARGET_SAMPLE_RATE as f64
}

fn write_session_audio(session_dir: &std::path::Path, buffer: &[f32], send: &dyn Fn(PipelineEvent)) {
    if let Err(e) = std::fs::create_dir_all(session_dir) {
        return send(PipelineEvent::Error {
            message: format!("failed to create {}: {e}", session_dir.display()),
        });
    }
    let path = session_dir.join("audio.wav");
    let path_str = path.to_string_lossy().into_owned();
    if !sherpa_onnx::write(&path_str, buffer, TARGET_SAMPLE_RATE as i32) {
        send(PipelineEvent::Error {
            message: format!("failed to write session audio to {path_str}"),
        });
    }
}

/// Stop-time refinement: diarize the retained audio, re-map each transcript
/// segment to the diarization speaker it most overlaps, re-letter by first
/// appearance, and re-match enrolled people per refined cluster. Falls back to
/// the online labels if diarization is unavailable or fails (spec §7.3).
fn refine(
    models: &SessionPipelineModels,
    buffer: &[f32],
    segments: &[CapturedSegment],
    labeler: &OnlineLabeler,
) -> Vec<SessionSegment> {
    let online = || {
        let clusters: Vec<usize> = segments.iter().map(|s| s.cluster).collect();
        let person_for_cluster = match_clusters_to_people(&clusters, segments, labeler);
        segments
            .iter()
            .map(|seg| SessionSegment {
                text: seg.text.clone(),
                start_ms: seg.start_ms,
                end_ms: seg.end_ms,
                speaker_label: letter_label(seg.cluster),
                person_id: person_for_cluster.get(seg.cluster).cloned().flatten(),
            })
            .collect()
    };
    if segments.is_empty() {
        return Vec::new();
    }
    let diarizer = match Diarizer::new(
        &models.diar_segmentation_dir,
        &models.diar_embedding_dir,
        models.num_threads,
    ) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[session] refinement skipped, diarizer load failed: {e}");
            return online();
        }
    };
    let diar = match diarizer.diarize(buffer, DiarizationParams::default()) {
        Ok((segs, _)) => segs,
        Err(e) => {
            log::warn!("[session] refinement skipped, diarize failed: {e}");
            return online();
        }
    };

    let spans: Vec<(f64, f64)> = segments.iter().map(|s| (s.start_ms, s.end_ms)).collect();
    let mapped = refine_speakers(&spans, &diar);
    let clusters = relabel_by_first_appearance(&mapped);

    // Re-match enrolled people per refined cluster from its segment embeddings.
    let person_for_cluster = match_clusters_to_people(&clusters, segments, labeler);

    segments
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

/// For each refined cluster index, the enrolled person id its mean embedding
/// matches (or None). `clusters[i]` is segment i's refined cluster.
fn match_clusters_to_people(
    clusters: &[usize],
    segments: &[CapturedSegment],
    labeler: &OnlineLabeler,
) -> Vec<Option<String>> {
    let embeddings: Vec<Option<Vec<f32>>> =
        segments.iter().map(|s| s.embedding.clone()).collect();
    cluster_means_to_people(clusters, &embeddings, &labeler.enrolled, labeler.match_threshold)
}

// ── Pure algorithmic core (unit-tested) ─────────────────────────────────────

/// Online (streaming) speaker clustering: assign each segment embedding to the
/// nearest running centroid above `cluster_threshold`, else open a new cluster.
/// Also reports an enrolled-Person match above `match_threshold` (spec §7.3).
struct OnlineLabeler {
    cluster_threshold: f32,
    match_threshold: f32,
    enrolled: Vec<EnrolledSpeaker>,
    /// Per cluster: running sum of embeddings and the count, giving the mean.
    sums: Vec<Vec<f32>>,
    counts: Vec<usize>,
}

impl OnlineLabeler {
    fn new(cluster_threshold: f32, match_threshold: f32, enrolled: Vec<EnrolledSpeaker>) -> Self {
        Self {
            cluster_threshold,
            match_threshold,
            enrolled,
            sums: Vec::new(),
            counts: Vec::new(),
        }
    }

    /// Assign an embedding to a cluster, returning (cluster index, person id).
    fn assign(&mut self, emb: &[f32]) -> (usize, Option<String>) {
        let mut best = None;
        let mut best_sim = self.cluster_threshold;
        for (i, (sum, &count)) in self.sums.iter().zip(self.counts.iter()).enumerate() {
            let mean: Vec<f32> = sum.iter().map(|v| v / count as f32).collect();
            let sim = cosine_similarity(&mean, emb);
            if sim >= best_sim {
                best_sim = sim;
                best = Some(i);
            }
        }
        let cluster = match best {
            Some(i) => {
                accumulate(&mut self.sums[i], emb);
                self.counts[i] += 1;
                i
            }
            None => {
                let i = self.sums.len();
                self.sums.push(emb.to_vec());
                self.counts.push(1);
                i
            }
        };
        (cluster, self.match_person(emb))
    }

    /// Open a cluster with no embedding (embedding extraction failed).
    fn new_cluster(&mut self) -> usize {
        let i = self.sums.len();
        self.sums.push(Vec::new());
        self.counts.push(0);
        i
    }

    /// Nearest enrolled person above the match threshold, if any.
    fn match_person(&self, emb: &[f32]) -> Option<String> {
        match_person(&self.enrolled, emb, self.match_threshold)
    }
}

/// Map each transcript segment (ms spans) to the diarization speaker it most
/// overlaps in time, summing overlap across all of that speaker's diarization
/// segments (a speaker can have several disjoint diarization spans inside one
/// transcript turn, e.g. either side of a brief interjection). No overlap →
/// nearest span by midpoint; no diarization → -1. This is the refinement
/// "overlap voting" the spec calls for.
fn refine_speakers(spans: &[(f64, f64)], diar: &[crate::engines::DiarizationSegment]) -> Vec<i32> {
    spans
        .iter()
        .map(|&(start_ms, end_ms)| {
            let start = start_ms / 1000.0;
            let end = end_ms / 1000.0;
            let mut overlap_by_speaker: std::collections::BTreeMap<i32, f64> =
                std::collections::BTreeMap::new();
            for d in diar {
                let overlap = (end.min(d.end as f64) - start.max(d.start as f64)).max(0.0);
                if overlap > 0.0 {
                    *overlap_by_speaker.entry(d.speaker).or_insert(0.0) += overlap;
                }
            }
            if let Some((&speaker, _)) = overlap_by_speaker
                .iter()
                .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            {
                return speaker;
            }
            // No temporal overlap: fall back to the nearest span by midpoint.
            let mid = (start + end) / 2.0;
            diar.iter()
                .min_by(|a, b| {
                    let da = ((a.start as f64 + a.end as f64) / 2.0 - mid).abs();
                    let db = ((b.start as f64 + b.end as f64) / 2.0 - mid).abs();
                    da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
                })
                .map_or(-1, |d| d.speaker)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::DiarizationSegment;

    #[test]
    fn online_labeler_reuses_cluster_for_similar_and_opens_for_different() {
        let mut labeler = OnlineLabeler::new(0.5, 0.9, Vec::new());
        let a1 = vec![1.0, 0.0, 0.0];
        let a2 = vec![0.9, 0.1, 0.0];
        let b1 = vec![0.0, 0.0, 1.0];
        assert_eq!(labeler.assign(&a1).0, 0);
        assert_eq!(labeler.assign(&a2).0, 0, "similar voice joins cluster A");
        assert_eq!(labeler.assign(&b1).0, 1, "different voice opens cluster B");
        assert_eq!(labeler.assign(&a1).0, 0, "back to cluster A");
    }

    #[test]
    fn online_labeler_matches_enrolled_person() {
        let enrolled = vec![EnrolledSpeaker {
            person_id: "martin".into(),
            embedding: vec![1.0, 0.0, 0.0],
        }];
        let mut labeler = OnlineLabeler::new(0.5, 0.8, enrolled);
        let (_, person) = labeler.assign(&vec![0.95, 0.05, 0.0]);
        assert_eq!(person.as_deref(), Some("martin"));
        let (_, none) = labeler.assign(&vec![0.0, 0.0, 1.0]);
        assert_eq!(none, None);
    }

    #[test]
    fn refine_speakers_assigns_by_max_overlap() {
        // Two turns; diarization says speaker 7 then speaker 3.
        let spans = vec![(0.0, 1000.0), (1000.0, 2000.0)];
        let diar = vec![
            DiarizationSegment { start: 0.0, end: 1.0, speaker: 7 },
            DiarizationSegment { start: 1.0, end: 2.0, speaker: 3 },
        ];
        assert_eq!(refine_speakers(&spans, &diar), vec![7, 3]);
    }

    #[test]
    fn refine_speakers_picks_dominant_overlap() {
        // Turn spans 0–2s but overlaps speaker 1 for 1.5s vs speaker 2 for 0.5s.
        let spans = vec![(0.0, 2000.0)];
        let diar = vec![
            DiarizationSegment { start: 0.0, end: 1.5, speaker: 1 },
            DiarizationSegment { start: 1.5, end: 2.0, speaker: 2 },
        ];
        assert_eq!(refine_speakers(&spans, &diar), vec![1]);
    }

    #[test]
    fn refine_speakers_sums_overlap_across_disjoint_spans_of_same_speaker() {
        // One transcript turn (0-3s) has speaker 1 in three short disjoint spans
        // (0.4s each, totaling 1.2s) around a single longer speaker-2 span
        // (1.0s). Picking by the single largest diarization segment would wrongly
        // choose speaker 2 (1.0 > 0.4); summing overlap per speaker across all of
        // its diarization segments correctly picks speaker 1 (1.2 > 1.0).
        let spans = vec![(0.0, 3000.0)];
        let diar = vec![
            DiarizationSegment { start: 0.0, end: 0.4, speaker: 1 },
            DiarizationSegment { start: 0.5, end: 1.5, speaker: 2 },
            DiarizationSegment { start: 1.6, end: 2.0, speaker: 1 },
            DiarizationSegment { start: 2.1, end: 2.5, speaker: 1 },
        ];
        assert_eq!(refine_speakers(&spans, &diar), vec![1]);
    }

    #[test]
    fn refine_speakers_falls_back_to_nearest_when_no_overlap() {
        let spans = vec![(5000.0, 6000.0)];
        let diar = vec![
            DiarizationSegment { start: 0.0, end: 1.0, speaker: 1 },
            DiarizationSegment { start: 4.0, end: 4.5, speaker: 2 },
        ];
        assert_eq!(refine_speakers(&spans, &diar), vec![2]);
    }
}
