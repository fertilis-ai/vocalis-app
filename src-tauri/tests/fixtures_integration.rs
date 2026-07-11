//! Fixture-based integration tests (spec §3.1, decision A.21).
//!
//! Run un-ignored under plain `cargo test`. Models come from
//! `fixtures/models/` (gitignored) — populate with `./fixtures/fetch.sh`.
//! When a fixture is absent the test skips with a pointer to fetch.sh,
//! so a fresh checkout still gets a green `cargo test`.
//!
//! Coverage: VAD + streaming ASR + speaker embedding + diarization (the
//! tasks with small models). TTS and full-size models stay in
//! engines_integration.rs as --ignored tests.

use std::path::{Path, PathBuf};

use vocalis_lib::engines::{
    cosine_similarity, detect_speech_spans, spot_keywords_in_clip, DiarizationParams, Diarizer,
    LangIdentifier, SourceSeparator, SpeakerEmbedder, SpeechDetector, StreamingAsrSession,
    VadParams,
};

fn fixtures_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures")
}

/// Some(path) when the fixture exists; None (after printing a skip note)
/// otherwise.
fn require_fixture(relative: &str) -> Option<PathBuf> {
    let path = fixtures_root().join(relative);
    if path.exists() {
        Some(path)
    } else {
        eprintln!("SKIP: fixture {relative} not found — run ./fixtures/fetch.sh");
        None
    }
}

fn speech_wav() -> (Vec<f32>, i32) {
    let path = fixtures_root().join("wavs/speech-en-16k.wav");
    let wave = sherpa_onnx::Wave::read(&path.to_string_lossy()).expect("failed to read fixture wav");
    (wave.samples().to_vec(), wave.sample_rate())
}

fn read_wav(path: &Path) -> Vec<f32> {
    let wave = sherpa_onnx::Wave::read(&path.to_string_lossy()).expect("failed to read fixture wav");
    assert_eq!(wave.sample_rate(), 16_000, "fixture wavs must be 16 kHz");
    wave.samples().to_vec()
}

#[test]
fn fixture_wav_is_committed_and_16k() {
    // The wav is committed (not fetched) — this must always pass.
    let (samples, rate) = speech_wav();
    assert_eq!(rate, 16_000, "fixture wav must be 16 kHz");
    assert!(samples.len() > 16_000, "fixture wav shorter than 1 s");
}

#[test]
fn vad_flips_on_fixture_speech_but_not_silence() {
    let Some(model) = require_fixture("models/vad/silero-vad-v5/silero_vad.onnx") else {
        return;
    };
    let mut vad = SpeechDetector::new(&model).unwrap();

    // 1 s of silence first: the detector must stay quiet.
    for _ in 0..10 {
        assert_ne!(vad.push(&[0.0f32; 1600]), Some(true), "VAD fired on silence");
    }

    let (samples, _) = speech_wav();
    let mut saw_speech = false;
    for chunk in samples.chunks(1600) {
        if vad.push(chunk) == Some(true) {
            saw_speech = true;
        }
    }
    assert!(saw_speech, "VAD never flipped to speaking on a speech wav");

    // 1 s more silence: the detector must flip back off (the wav itself
    // already ends with 0.5 s of silence).
    for _ in 0..10 {
        vad.push(&[0.0f32; 1600]);
    }
    assert!(!vad.is_speaking(), "VAD stuck speaking after trailing silence");
}

#[test]
fn offline_vad_finds_speech_spans_in_fixture_wav() {
    let Some(model) = require_fixture("models/vad/silero-vad-v5/silero_vad.onnx") else {
        return;
    };
    let (samples, _) = speech_wav();
    let duration = samples.len() as f32 / 16_000.0;

    let spans = detect_speech_spans(&model, &samples, VadParams::default()).unwrap();
    assert!(!spans.is_empty(), "no speech spans found in a speech wav");
    for span in &spans {
        assert!(span.start >= 0.0 && span.end <= duration + 0.1);
        assert!(span.end > span.start, "empty/inverted span");
    }

    // Pure silence must produce no spans.
    let silence = vec![0.0f32; 32_000];
    let none = detect_speech_spans(&model, &silence, VadParams::default()).unwrap();
    assert!(none.is_empty(), "spans detected in silence: {}", none.len());
}

#[test]
fn speaker_embedding_is_stable_and_consistent() {
    let Some(model_dir) = require_fixture("models/speaker-embedding/campplus-en-voxceleb") else {
        return;
    };
    let embedder = SpeakerEmbedder::new(&model_dir, 2).unwrap();
    assert!(embedder.dim() > 0, "embedding dim must be positive");

    let (samples, _) = speech_wav();
    let full = embedder.embed(&samples).unwrap();
    assert_eq!(full.len(), embedder.dim(), "embedding length matches dim");
    assert!(
        full.iter().any(|v| v.abs() > 1e-6),
        "embedding must not be all zeros"
    );
    assert!(
        (cosine_similarity(&full, &full) - 1.0).abs() < 1e-5,
        "self-similarity must be 1"
    );

    // Two halves of one clip are the same speaker: expect clearly positive
    // similarity (cross-speaker pairs typically land near or below zero).
    let mid = samples.len() / 2;
    let first = embedder.embed(&samples[..mid]).unwrap();
    let second = embedder.embed(&samples[mid..]).unwrap();
    let same_speaker = cosine_similarity(&first, &second);
    assert!(
        same_speaker > 0.2,
        "same-speaker halves score too low: {same_speaker}"
    );
}

// The two real-speaker tests use the zh CAM++ embedding model because the
// pinned reference wavs are Chinese; the shipped en-voxceleb model cannot
// discriminate them (language mismatch, observed same 0.26 < cross 0.48).
// They exercise our wrapper plumbing, not the catalog model's quality.
#[test]
fn speaker_embeddings_discriminate_real_speakers() {
    let Some(model_dir) = require_fixture("models/speaker-embedding-zh/campplus-zh-cn") else {
        return;
    };
    let Some(clip_1a) = require_fixture("wavs/fetched/speaker1-a-cn-16k.wav") else {
        return;
    };
    let Some(clip_1b) = require_fixture("wavs/fetched/speaker1-b-cn-16k.wav") else {
        return;
    };
    let Some(clip_2a) = require_fixture("wavs/fetched/speaker2-a-cn-16k.wav") else {
        return;
    };
    let embedder = SpeakerEmbedder::new(&model_dir, 2).unwrap();

    let e1a = embedder.embed(&read_wav(&clip_1a)).unwrap();
    let e1b = embedder.embed(&read_wav(&clip_1b)).unwrap();
    let e2a = embedder.embed(&read_wav(&clip_2a)).unwrap();

    let same = cosine_similarity(&e1a, &e1b);
    let cross_a = cosine_similarity(&e1a, &e2a);
    let cross_b = cosine_similarity(&e1b, &e2a);
    println!("same-speaker {same:.3}, cross-speaker {cross_a:.3} / {cross_b:.3}");
    // Comfortable margins on both sides of the default 0.5 verify threshold.
    assert!(same > 0.5, "same-speaker clips must verify: {same}");
    assert!(
        cross_a < 0.4 && cross_b < 0.4,
        "different speakers must not verify: {cross_a} / {cross_b}"
    );
}

#[test]
fn diarization_separates_real_speakers() {
    let Some(segmentation_dir) = require_fixture("models/diarization/pyannote-segmentation-3-0")
    else {
        return;
    };
    let Some(embedding_dir) = require_fixture("models/speaker-embedding-zh/campplus-zh-cn") else {
        return;
    };
    let Some(wav) = require_fixture("wavs/fetched/four-speakers-zh-16k.wav") else {
        return;
    };
    let samples = read_wav(&wav);
    let duration = samples.len() as f32 / 16_000.0;
    let diarizer = Diarizer::new(&segmentation_dir, &embedding_dir, 2).unwrap();

    // Auto speaker count: the clip has four speakers; require at least two so
    // the assertion survives clustering-threshold drift.
    let (segments, num_speakers) = diarizer
        .diarize(&samples, DiarizationParams::default())
        .unwrap();
    println!("auto: {num_speakers} speakers, {} segments", segments.len());
    assert!(
        num_speakers >= 2,
        "expected multiple speakers in a four-speaker clip, got {num_speakers}"
    );
    assert!(segments.len() >= num_speakers as usize);
    for segment in &segments {
        assert!(segment.start >= 0.0 && segment.end <= duration + 0.1);
        assert!(segment.end > segment.start, "empty/inverted segment");
    }

    // Known speaker count constrains the clustering; sherpa may still emit
    // fewer distinct labels than requested (short clusters get filtered), so
    // require "multiple" rather than exactly four.
    let (_, pinned) = diarizer
        .diarize(
            &samples,
            DiarizationParams {
                num_speakers: Some(4),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(pinned >= 2, "requested four clusters, got {pinned}");
}

#[test]
fn diarization_finds_speech_segments_in_fixture_wav() {
    let Some(segmentation_dir) = require_fixture("models/diarization/pyannote-segmentation-3-0")
    else {
        return;
    };
    let Some(embedding_dir) = require_fixture("models/speaker-embedding/campplus-en-voxceleb")
    else {
        return;
    };
    let diarizer = Diarizer::new(&segmentation_dir, &embedding_dir, 2).unwrap();
    assert_eq!(diarizer.sample_rate(), 16_000, "pyannote expects 16 kHz");

    let (samples, _) = speech_wav();
    let duration = samples.len() as f32 / 16_000.0;
    let (segments, num_speakers) = diarizer
        .diarize(&samples, DiarizationParams::default())
        .unwrap();

    assert!(!segments.is_empty(), "no segments in a speech wav");
    assert!(num_speakers >= 1, "expected at least one speaker");
    let distinct = segments
        .iter()
        .map(|s| s.speaker)
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        distinct.len() as i32,
        num_speakers,
        "num_speakers must count the distinct labels"
    );
    for segment in &segments {
        assert!(segment.start >= 0.0 && segment.end <= duration + 0.1);
        assert!(segment.end > segment.start, "empty/inverted segment");
        assert!(segment.speaker >= 0, "negative speaker label");
    }
    assert!(
        segments.windows(2).all(|w| w[0].start <= w[1].start),
        "segments must be sorted by start time"
    );
}

#[test]
fn langid_identifies_english_fixture() {
    let Some(model_dir) = require_fixture("models/lang-id/whisper-tiny-langid") else {
        return;
    };
    let (samples, _) = speech_wav();
    let engine = LangIdentifier::new(&model_dir, 4).unwrap();
    let lang = engine.identify(&samples).unwrap();
    println!("detected language: {lang}");
    assert_eq!(lang, "en", "English fixture must be identified as English");
}

#[test]
fn separation_splits_fixture_into_two_stems() {
    let Some(model_dir) = require_fixture("models/separation/spleeter-2stems-fp16") else {
        return;
    };
    let (samples, rate) = speech_wav();
    let separator = SourceSeparator::new(&model_dir, 4).unwrap();
    let stems = separator.separate(&samples, rate as u32).unwrap();
    assert_eq!(stems.len(), 2, "Spleeter 2-stems must return two stems");
    for stem in &stems {
        assert!(!stem.samples.is_empty(), "stem has no samples");
        assert!(stem.sample_rate > 0, "stem sample rate must be positive");
        assert!(
            stem.samples.iter().any(|s| s.abs() > 1e-6),
            "stem is all silence"
        );
    }
}

#[test]
fn kws_detects_bundled_keyword_in_test_wav() {
    let Some(model_dir) = require_fixture("models/kws/kws-zipformer-gigaspeech") else {
        return;
    };
    // 0.wav in this model's test set says "…LIGHT UP…"; test_keywords.txt gives
    // its tokenized form. The bundled keywords (HELLO WORLD, …) do not appear.
    let wav = model_dir.join("test_wavs/0.wav");
    let samples = read_wav(&wav);

    let hits = spot_keywords_in_clip(&model_dir, 2, 2.0, "▁ L IGHT ▁UP", &samples).unwrap();
    println!("kws hits: {:?}", hits.iter().map(|h| &h.keyword).collect::<Vec<_>>());
    assert!(
        hits.iter().any(|h| h.keyword.to_uppercase().contains("LIGHT")),
        "expected to spot 'LIGHT UP' in the test wav, got {:?}",
        hits.iter().map(|h| &h.keyword).collect::<Vec<_>>()
    );
    for hit in &hits {
        assert!(hit.start_time >= 0.0, "negative keyword timestamp");
    }
}

#[test]
fn streaming_asr_transcribes_fixture_wav() {
    let Some(model_dir) = require_fixture("models/asr-streaming/zipformer-en-20M") else {
        return;
    };
    let (samples, _) = speech_wav();

    let mut asr = StreamingAsrSession::new(&model_dir, 2).unwrap();
    let mut text = String::new();
    // Feed in 100 ms chunks like the live pipeline does.
    for chunk in samples.chunks(1600) {
        if let Some(partial) = asr.push(chunk) {
            text = partial;
        }
    }
    // Trailing silence so the endpoint rule fires a final.
    for _ in 0..30 {
        asr.push(&[0.0f32; 1600]);
        if let Some(segment) = asr.take_final() {
            text = segment.text;
            break;
        }
    }

    let text = text.to_lowercase();
    println!("transcript: {text}");
    assert!(
        text.contains("fox") || text.contains("dog"),
        "unexpected transcript for 'the quick brown fox jumps over the lazy dog': {text}"
    );
}
