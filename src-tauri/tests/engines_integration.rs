//! Integration tests against real models in ~/.vocalis/models/.
//!
//! Run with: cargo test --test engines_integration -- --ignored
//! (ignored by default: they need models downloaded via the Models section
//! and ~1 GB of RAM; CI uses tiny fixture models instead — spec §Appendix A.21.)

use vocalis_lib::engines::{
    cosine_similarity, DiarizationParams, Diarizer, SpeakerEmbedder, SpeechDetector, TtsEngine,
    StreamingAsrSession,
};
use vocalis_lib::registry;

fn wav_samples(path: &std::path::Path) -> (Vec<f32>, i32) {
    let wave = sherpa_onnx::Wave::read(&path.to_string_lossy()).expect("failed to read wav");
    (wave.samples().to_vec(), wave.sample_rate())
}

#[test]
#[ignore]
fn streaming_asr_transcribes_test_wav() {
    let asr_dir = registry::first_installed("asr-streaming")
        .unwrap()
        .expect("no asr-streaming model installed");
    let test_wav = asr_dir.join("test_wavs/0.wav");
    let (samples, rate) = wav_samples(&test_wav);
    assert_eq!(rate, 16_000, "test wav must be 16kHz");

    let mut asr = StreamingAsrSession::new(&asr_dir, 2).unwrap();
    let mut last_partial = String::new();
    // Feed in 100ms chunks like the live pipeline does.
    for chunk in samples.chunks(1600) {
        if let Some(partial) = asr.push(chunk) {
            last_partial = partial;
        }
    }
    // Trailing silence so the endpoint rule fires.
    for _ in 0..30 {
        asr.push(&[0.0f32; 1600]);
        if let Some(fin) = asr.take_final() {
            assert!(!fin.words.is_empty(), "final segment carries word timestamps");
            last_partial = fin.text;
            break;
        }
    }

    let text = last_partial.to_lowercase();
    println!("transcript: {text}");
    assert!(!text.is_empty(), "expected a transcript");
    // 0.wav in the zipformer release says "after early nightfall the yellow
    // lamps would light up here and there the squalid quarter of the brothels"
    assert!(
        text.contains("nightfall") || text.contains("yellow"),
        "unexpected transcript: {text}"
    );
}

#[test]
#[ignore]
fn offline_whisper_transcribes_test_wav() {
    use std::time::Instant;
    use vocalis_lib::engines::OfflineAsr;

    let batch_dir = registry::first_installed("asr-batch")
        .unwrap()
        .expect("no asr-batch model installed");
    let asr_dir = registry::first_installed("asr-streaming")
        .unwrap()
        .expect("no asr-streaming model installed");
    let (samples, rate) = wav_samples(&asr_dir.join("test_wavs/0.wav"));
    assert_eq!(rate, 16_000);

    // 2 threads matches the interactive pipelines' ASR_THREADS (chat_capture,
    // dictation, session_pipeline_start) — this measures the same
    // per-utterance batch-decode latency they see in production.
    let asr = OfflineAsr::new(&batch_dir, 2, Some("en")).unwrap();
    let started = Instant::now();
    let result = asr.transcribe(&samples).unwrap();
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    let audio_secs = samples.len() as f64 / rate as f64;
    println!(
        "whisper batch decode: {audio_secs:.1}s audio in {elapsed_ms:.0}ms (rtf {:.2}, 2 threads)",
        elapsed_ms / 1000.0 / audio_secs.max(0.001)
    );
    let text = result.text.to_lowercase();
    println!("whisper transcript: {text}");
    assert!(
        text.contains("nightfall") || text.contains("yellow"),
        "unexpected transcript: {text}"
    );
    // The stock k2-fsa whisper export has no cross-attention outputs, so
    // token timestamps are unavailable and words stays empty (the UI shows
    // plain text then). If present (custom export), starts must be ordered.
    let starts: Vec<f32> = result.words.iter().map(|w| w.start).collect();
    assert!(
        starts.windows(2).all(|pair| pair[0] <= pair[1]),
        "word starts must be non-decreasing: {starts:?}"
    );
}

#[test]
#[ignore]
fn streaming_zipformer_transcribes_whole_file() {
    let asr_dir = registry::first_installed("asr-streaming")
        .unwrap()
        .expect("no asr-streaming model installed");
    let (samples, _) = wav_samples(&asr_dir.join("test_wavs/0.wav"));

    let session = StreamingAsrSession::new(&asr_dir, 4).unwrap();
    let result = session.transcribe_file(&samples).unwrap();
    let text = result.text.to_lowercase();
    println!("zipformer file transcript: {text}");
    assert!(
        text.contains("nightfall") || text.contains("yellow"),
        "unexpected transcript: {text}"
    );
    assert!(!result.words.is_empty(), "expected word timestamps");
}

#[test]
#[ignore]
fn vad_detects_speech_in_test_wav() {
    let asr_dir = registry::first_installed("asr-streaming")
        .unwrap()
        .expect("no asr-streaming model installed");
    let vad_dir = registry::first_installed("vad")
        .unwrap()
        .expect("no vad model installed");
    let vad_path = registry::find_file(&vad_dir, "silero", ".onnx").unwrap();

    let (samples, _) = wav_samples(&asr_dir.join("test_wavs/0.wav"));
    let mut vad = SpeechDetector::new(&vad_path).unwrap();

    let mut saw_speech = false;
    for chunk in samples.chunks(1600) {
        if vad.push(chunk) == Some(true) {
            saw_speech = true;
        }
    }
    assert!(saw_speech, "VAD never flipped to speaking on a speech wav");
}

#[test]
#[ignore]
fn kokoro_synthesizes_audio() {
    let tts_dir = registry::first_installed("tts")
        .unwrap()
        .expect("no tts model installed");
    let tts = TtsEngine::new(&tts_dir, 4).unwrap();
    assert!(tts.num_speakers() > 0);

    let out = std::env::temp_dir().join("vocalis-test-tts.wav");
    let duration = tts
        .synthesize_to_wav("Vocalis integration test.", 0, 1.0, &out)
        .unwrap();
    assert!(duration > 0.5, "expected >0.5s of audio, got {duration}");
    assert!(out.exists());
    std::fs::remove_file(out).ok();
}

#[test]
#[ignore]
fn zipvoice_clones_from_reference() {
    use std::time::Instant;
    use vocalis_lib::engines::{CloneTtsEngine, CLONE_TTS_DEFAULT_STEPS};

    let dir = registry::first_installed("clone-tts")
        .unwrap()
        .expect("no clone-tts model installed");
    // The model ships zh reference fixtures with exact transcripts; the
    // engine is zh/en so an English synth from a zh reference is in-domain.
    let (ref_samples, ref_rate) = wav_samples(&dir.join("test_wavs/news-female.wav"));
    let ref_text = "各位村民, 大家新年好! 近期, 湖北省武汉市等多个地区";

    let load_started = Instant::now();
    let engine = CloneTtsEngine::new(&dir, 8).unwrap();
    let load_secs = load_started.elapsed().as_secs_f64();

    let out = std::env::temp_dir().join("vocalis-test-clone-tts.wav");
    let started = Instant::now();
    let duration = engine
        .synthesize_to_wav(
            "The quick brown fox jumps over the lazy dog.",
            &ref_samples,
            ref_rate,
            ref_text,
            1.0,
            CLONE_TTS_DEFAULT_STEPS,
            &out,
        )
        .unwrap();
    let synth_secs = started.elapsed().as_secs_f64();
    // TTFA log per M5 item 2 (spike baseline: ~0.8 s short sentence, 8 threads).
    println!(
        "zipvoice: load {load_secs:.2}s, {duration:.2}s audio in {synth_secs:.2}s (rtf {:.2})",
        synth_secs / duration.max(0.001)
    );
    assert!(duration > 1.0, "expected >1s of audio, got {duration}");
    assert!(out.exists());
    std::fs::remove_file(out).ok();
}

#[test]
#[ignore]
fn speaker_embedding_verifies_same_voice_on_test_wav() {
    let embed_dir = registry::first_installed("speaker-embedding")
        .unwrap()
        .expect("no speaker-embedding model installed");
    let asr_dir = registry::first_installed("asr-streaming")
        .unwrap()
        .expect("no asr-streaming model installed");
    let (samples, _) = wav_samples(&asr_dir.join("test_wavs/0.wav"));

    let embedder = SpeakerEmbedder::new(&embed_dir, 2).unwrap();
    let mid = samples.len() / 2;
    let first = embedder.embed(&samples[..mid]).unwrap();
    let second = embedder.embed(&samples[mid..]).unwrap();
    assert_eq!(first.len(), embedder.dim());

    let same = cosine_similarity(&first, &second);
    println!("same-voice halves: {same:.3}");
    assert!(
        same > 0.5,
        "two halves of one English voice must verify: {same}"
    );
}

#[test]
#[ignore]
fn diarization_segments_test_wav_with_installed_models() {
    let segmentation_dir = registry::first_installed("diarization")
        .unwrap()
        .expect("no diarization model installed");
    let embed_dir = registry::first_installed("speaker-embedding")
        .unwrap()
        .expect("no speaker-embedding model installed");
    let asr_dir = registry::first_installed("asr-streaming")
        .unwrap()
        .expect("no asr-streaming model installed");
    let (samples, _) = wav_samples(&asr_dir.join("test_wavs/0.wav"));
    let duration = samples.len() as f32 / 16_000.0;

    let diarizer = Diarizer::new(&segmentation_dir, &embed_dir, 4).unwrap();
    let (segments, num_speakers) = diarizer
        .diarize(&samples, DiarizationParams::default())
        .unwrap();
    println!("{num_speakers} speakers, {} segments", segments.len());
    assert!(!segments.is_empty(), "no segments in a speech wav");
    assert!(num_speakers >= 1);
    for s in &segments {
        assert!(s.start >= 0.0 && s.end <= duration + 0.1 && s.end > s.start);
    }
}

#[test]
#[ignore]
fn punctuator_restores_punctuation() {
    use vocalis_lib::engines::Punctuator;

    let punct_dir = registry::first_installed("punctuation")
        .unwrap()
        .expect("no punctuation model installed");
    let punct = Punctuator::new(&punct_dir, 2).unwrap();

    let out = punct.punctuate("today is a good day how are you");
    println!("punctuated: {out}");
    assert!(
        out.contains(',') || out.contains('?') || out.contains('.'),
        "expected punctuation marks in: {out}"
    );
    assert_eq!(punct.punctuate("  "), "  ", "whitespace passes through");
}

#[test]
#[ignore]
fn langid_identifies_english() {
    use vocalis_lib::engines::LangIdentifier;

    let model_dir = registry::first_installed("lang-id")
        .unwrap()
        .expect("no lang-id model installed");
    let asr_dir = registry::first_installed("asr-streaming")
        .unwrap()
        .expect("no asr-streaming model installed");
    let (samples, rate) = wav_samples(&asr_dir.join("test_wavs/0.wav"));
    assert_eq!(rate, 16_000);

    let engine = LangIdentifier::new(&model_dir, 4).unwrap();
    let lang = engine.identify(&samples).unwrap();
    println!("detected language: {lang}");
    assert_eq!(lang, "en", "0.wav is English");
}

#[test]
#[ignore]
fn source_separation_yields_two_stems() {
    use vocalis_lib::engines::SourceSeparator;

    let model_dir = registry::first_installed("separation")
        .unwrap()
        .expect("no separation model installed");
    let asr_dir = registry::first_installed("asr-streaming")
        .unwrap()
        .expect("no asr-streaming model installed");
    let (samples, rate) = wav_samples(&asr_dir.join("test_wavs/0.wav"));

    let separator = SourceSeparator::new(&model_dir, 4).unwrap();
    let stems = separator.separate(&samples, rate as u32).unwrap();
    assert_eq!(stems.len(), 2, "Spleeter 2-stems must return two stems");
    for stem in &stems {
        assert!(!stem.samples.is_empty(), "stem has no samples");
        assert!(stem.samples.iter().any(|s| s.abs() > 1e-6), "stem is silent");
    }
}

#[test]
#[ignore]
fn kws_spots_bundled_keyword() {
    use vocalis_lib::engines::spot_keywords_in_clip;

    let model_dir = registry::first_installed("kws")
        .unwrap()
        .expect("no kws model installed");
    // This model ships test_wavs/0.wav ("…LIGHT UP…") with a matching keyword.
    let (samples, _) = wav_samples(&model_dir.join("test_wavs/0.wav"));

    let hits = spot_keywords_in_clip(&model_dir, 2, 2.0, "▁ L IGHT ▁UP", &samples).unwrap();
    println!("kws hits: {:?}", hits.iter().map(|h| &h.keyword).collect::<Vec<_>>());
    assert!(
        hits.iter().any(|h| h.keyword.to_uppercase().contains("LIGHT")),
        "expected to spot 'LIGHT UP'"
    );
}
