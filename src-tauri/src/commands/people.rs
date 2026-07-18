use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::commands::speech::{read_wav_16k, resolve_model_dir, resolve_vad_path};
use crate::commands::{app_data_dir, expand_tilde};
use crate::audio::TARGET_SAMPLE_RATE;
use crate::engines::{detect_speech_spans, SpeakerEmbedder, VadParams};
use crate::pipeline::{start_recorder, EnrolledSpeaker, RecorderEvent};
use crate::registry::download::validate_path_component;
use crate::state::SpeechState;

// People enrollment (spec §2.4, §3.5, M3 item 3). A Person lives under
// ~/.vocalis/people/<id>/ with a webview-owned profile.json, enrollment clips,
// and this module's `embedding.bin` (the averaged enrollment embedding, raw f32
// little-endian). The webview owns the metadata; Rust owns audio → embedding.

/// Enrollment runs a rare one-shot embed, not the realtime path — give it the
/// same modest thread count the other speaker commands use.
const ENROLL_SPEAKER_THREADS: i32 = 2;

fn person_dir(person_id: &str) -> Result<PathBuf, String> {
    validate_path_component(person_id)?;
    Ok(app_data_dir()?.join("people").join(person_id))
}

/// Start recording an enrollment clip into
/// people/<id>/enrollment/clip-<slot>.wav. Reuses the bench recorder, so stop
/// via `record_stop` / cancel via `record_cancel`; the saved path arrives as a
/// `RecorderEvent::Saved`. WAV, not FLAC, matching item 2's sanctioned fallback.
#[tauri::command]
pub fn enroll_record_start(
    state: State<'_, SpeechState>,
    channel: Channel<RecorderEvent>,
    person_id: String,
    slot: u32,
    input_device: Option<String>,
) -> Result<u32, String> {
    let out_path = person_dir(&person_id)?
        .join("enrollment")
        .join(format!("clip-{slot}.wav"));
    let id = start_recorder(&state.recorders, out_path, input_device, channel);
    log::info!("[people] started enrollment recorder {id} for {person_id} slot {slot}");
    Ok(id)
}

/// Start recording a clone reference clip into
/// people/<id>/clone-ref/clip-<slot>.wav (M5 item 1). Same recorder as
/// enrollment: stop via `record_stop`, cancel via `record_cancel`, saved path
/// arrives as `RecorderEvent::Saved`. WAV rather than FLAC, matching the
/// enrollment flow's sanctioned fallback.
#[tauri::command]
pub fn clone_ref_record_start(
    state: State<'_, SpeechState>,
    channel: Channel<RecorderEvent>,
    person_id: String,
    slot: u32,
    input_device: Option<String>,
) -> Result<u32, String> {
    let out_path = person_dir(&person_id)?
        .join("clone-ref")
        .join(format!("clip-{slot}.wav"));
    let id = start_recorder(&state.recorders, out_path, input_device, channel);
    log::info!("[people] started clone-ref recorder {id} for {person_id} slot {slot}");
    Ok(id)
}

/// Raw quality measurements for a clone reference take (M5 item 1). Rust
/// measures, the webview judges: pass/fail thresholds (clipping, level floor,
/// noise ceiling) live in TS where they're unit-testable and shown per take.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipQuality {
    pub duration_secs: f64,
    /// Absolute sample peak over the whole clip (clipping when ≥ ~0.99).
    pub peak: f32,
    /// RMS over the whole clip.
    pub rms: f32,
    /// RMS inside VAD speech spans (the signal level).
    pub speech_rms: f32,
    /// RMS outside VAD speech spans (the noise floor). 0 when no silence.
    pub noise_rms: f32,
    /// Total speech time found by the VAD.
    pub speech_secs: f64,
}

/// Analyze a recorded clone-ref take: overall peak/rms plus Silero-VAD-split
/// speech level vs. silence noise floor.
#[tauri::command]
pub fn clone_ref_quality(path: String, vad_model: Option<String>) -> Result<ClipQuality, String> {
    let samples = read_wav_16k(&path)?;
    if samples.is_empty() {
        return Err(format!("no audio in {path}"));
    }
    let duration_secs = samples.len() as f64 / TARGET_SAMPLE_RATE as f64;
    let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    let rms = rms_of(&samples);

    let vad_path = resolve_vad_path(vad_model)?;
    let spans = detect_speech_spans(&vad_path, &samples, VadParams::default())?;
    let mut speech: Vec<f32> = Vec::new();
    let mut silence: Vec<f32> = Vec::new();
    let mut cursor = 0usize;
    for span in &spans {
        let start = (span.start as f64 * TARGET_SAMPLE_RATE as f64) as usize;
        let end = ((span.end as f64 * TARGET_SAMPLE_RATE as f64) as usize).min(samples.len());
        silence.extend_from_slice(&samples[cursor.min(start)..start]);
        speech.extend_from_slice(&samples[start.min(end)..end]);
        cursor = end;
    }
    silence.extend_from_slice(&samples[cursor.min(samples.len())..]);

    let speech_secs = speech.len() as f64 / TARGET_SAMPLE_RATE as f64;
    log::info!(
        "[people] clone-ref quality {path}: peak {peak:.3} rms {rms:.4} speech {speech_secs:.1}s"
    );
    Ok(ClipQuality {
        duration_secs,
        peak,
        rms,
        speech_rms: rms_of(&speech),
        noise_rms: rms_of(&silence),
        speech_secs,
    })
}

fn rms_of(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollResult {
    /// Path relative to people/<id>/ — always "embedding.bin".
    pub embedding_path: String,
    /// Vector length, so the webview can record it in profile.json.
    pub embedding_dim: usize,
}

/// Build a Person's enrollment embedding: embed each clip, average them, and
/// write people/<id>/embedding.bin (raw f32 little-endian). `clips` are absolute
/// wav paths (the recorder's `Saved` paths). Averaging matches the spec §3.5 and
/// the playground identification manager's per-name averaging.
#[tauri::command]
pub fn enroll_person(
    person_id: String,
    clips: Vec<String>,
    model: Option<String>,
) -> Result<EnrollResult, String> {
    if clips.is_empty() {
        return Err("record at least one enrollment clip first".into());
    }
    let model_dir = resolve_model_dir("speaker-embedding", model, "speaker embedding")?;
    let embedder = SpeakerEmbedder::new(&model_dir, ENROLL_SPEAKER_THREADS)?;

    let mut sum: Vec<f32> = Vec::new();
    for clip in &clips {
        let samples = read_wav_16k(clip)?;
        let embedding = embedder
            .embed(&samples)
            .map_err(|e| format!("{clip}: {e}"))?;
        if sum.is_empty() {
            sum = embedding;
        } else if sum.len() == embedding.len() {
            for (s, e) in sum.iter_mut().zip(embedding.iter()) {
                *s += e;
            }
        } else {
            return Err("enrollment clips produced mismatched embedding sizes".into());
        }
    }
    let count = clips.len() as f32;
    let mean: Vec<f32> = sum.iter().map(|v| v / count).collect();
    let dim = mean.len();

    let dir = person_dir(&person_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    write_embedding(&dir.join("embedding.bin"), &mean)?;
    log::info!("[people] enrolled {person_id}: {} clips, dim {dim}", clips.len());
    Ok(EnrollResult {
        embedding_path: "embedding.bin".into(),
        embedding_dim: dim,
    })
}

/// A webview reference to an enrolled Person, passed to `session_pipeline_start`.
/// The webview owns which people exist; Rust reads the raw embedding so f32
/// arrays never cross the IPC boundary.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrolledPersonRef {
    pub person_id: String,
    /// Path to the person's embedding.bin (tilde-expanded before reading).
    pub embedding_path: String,
}

/// Resolve webview enrolled-person refs into loaded embeddings for the session
/// pipeline. A person whose embedding is missing/corrupt is skipped with a warn,
/// never a hard failure — one bad profile shouldn't block a whole session.
pub fn load_enrolled(refs: Vec<EnrolledPersonRef>) -> Vec<EnrolledSpeaker> {
    refs.into_iter()
        .filter_map(|r| match read_embedding(Path::new(&expand_tilde(&r.embedding_path))) {
            Ok(embedding) => Some(EnrolledSpeaker {
                person_id: r.person_id,
                embedding,
            }),
            Err(e) => {
                log::warn!("[people] skipping enrolled {}: {e}", r.person_id);
                None
            }
        })
        .collect()
}

/// Write an embedding as raw little-endian f32.
fn write_embedding(path: &Path, embedding: &[f32]) -> Result<(), String> {
    let mut bytes = Vec::with_capacity(embedding.len() * 4);
    for v in embedding {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, bytes).map_err(|e| format!("failed to write {}: {e}", path.display()))
}

/// Read a raw little-endian f32 embedding written by `enroll_person`.
fn read_embedding(path: &Path) -> Result<Vec<f32>, String> {
    let bytes =
        std::fs::read(path).map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return Err(format!("malformed embedding file {}", path.display()));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedding_round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("vocalis-emb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("embedding.bin");
        let emb = vec![0.5f32, -1.25, 3.0, 0.0];
        write_embedding(&path, &emb).unwrap();
        assert_eq!(read_embedding(&path).unwrap(), emb);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_embedding_rejects_truncated_files() {
        let dir = std::env::temp_dir().join(format!("vocalis-emb-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("embedding.bin");
        std::fs::write(&path, [1u8, 2, 3]).unwrap(); // not a multiple of 4
        assert!(read_embedding(&path).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_enrolled_skips_missing_files() {
        let loaded = load_enrolled(vec![EnrolledPersonRef {
            person_id: "ghost".into(),
            embedding_path: "/nonexistent/embedding.bin".into(),
        }]);
        assert!(loaded.is_empty());
    }

    #[test]
    fn person_dir_rejects_path_traversal() {
        assert!(person_dir("../../etc").is_err());
        assert!(person_dir("a/b").is_err());
        assert!(person_dir("legit-id-123").is_ok());
    }
}
