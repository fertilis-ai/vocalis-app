use std::sync::atomic::{AtomicBool, Ordering};

use crate::audio::TARGET_SAMPLE_RATE;
use crate::engines::{OfflineAsr, Transcription, WordSpan};

// Shared building block for "VAD-gated batch ASR" pipelines (chat capture,
// live sessions, dictation, and file import) — spec §0/§3.2: turn boundaries
// stay VAD-driven, but decode happens as one batch pass per utterance instead
// of incremental streaming partials. VAD edge detection itself needs nothing
// new (`SpeechDetector::push` already reports state flips); what's genuinely
// shared is chunking + timestamp stitching for utterances that exceed one
// attention window.

/// Whisper's context window is ~30 s; keep ASR chunks safely under it so a
/// long utterance is transcribed in pieces rather than truncated.
pub const MAX_ASR_CHUNK_SAMPLES: usize = 28 * TARGET_SAMPLE_RATE as usize;

/// Split [start, end) into contiguous chunks of at most `max_len` samples.
/// Returns a single chunk when the span already fits (the common case).
pub fn chunk_span(start: usize, end: usize, max_len: usize) -> Vec<(usize, usize)> {
    if end <= start {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut cursor = start;
    while cursor < end {
        let next = (cursor + max_len).min(end);
        chunks.push((cursor, next));
        cursor = next;
    }
    chunks
}

/// Batch-decode one utterance via `decode`, chunking it if it exceeds
/// `max_len` samples and stitching word timestamps across chunk boundaries by
/// offsetting each chunk's word starts by its position in `samples`. Checks
/// `stop` between chunks so a long multi-chunk decode can still be cancelled
/// promptly (`Ok(None)`). `decode` is injectable so this stitching logic is
/// unit-testable without a real ASR model.
pub fn transcribe_chunks<F>(
    samples: &[f32],
    max_len: usize,
    stop: &AtomicBool,
    mut decode: F,
) -> Result<Option<Transcription>, String>
where
    F: FnMut(&[f32]) -> Result<Transcription, String>,
{
    let mut text_parts: Vec<String> = Vec::new();
    let mut words: Vec<WordSpan> = Vec::new();
    for (start, end) in chunk_span(0, samples.len(), max_len) {
        if stop.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let chunk = decode(&samples[start..end])?;
        let offset = start as f32 / TARGET_SAMPLE_RATE as f32;
        if !chunk.text.trim().is_empty() {
            text_parts.push(chunk.text.trim().to_string());
        }
        words.extend(chunk.words.into_iter().map(|w| WordSpan {
            text: w.text,
            start: w.start + offset,
        }));
    }
    Ok(Some(Transcription {
        text: text_parts.join(" "),
        words,
    }))
}

/// Batch-decode one VAD-bounded utterance against a real `OfflineAsr` model.
pub fn transcribe_utterance(
    asr: &OfflineAsr,
    samples: &[f32],
    stop: &AtomicBool,
) -> Result<Option<Transcription>, String> {
    transcribe_chunks(samples, MAX_ASR_CHUNK_SAMPLES, stop, |chunk| asr.transcribe(chunk))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn not_stopped() -> AtomicBool {
        AtomicBool::new(false)
    }

    #[test]
    fn chunk_span_returns_single_chunk_when_it_fits() {
        assert_eq!(chunk_span(0, 100, 448_000), vec![(0, 100)]);
        assert_eq!(chunk_span(50, 200, 448_000), vec![(50, 200)]);
    }

    #[test]
    fn chunk_span_splits_long_spans() {
        assert_eq!(chunk_span(0, 250, 100), vec![(0, 100), (100, 200), (200, 250)]);
    }

    #[test]
    fn chunk_span_empty_for_degenerate_range() {
        assert!(chunk_span(100, 100, 100).is_empty());
        assert!(chunk_span(200, 100, 100).is_empty());
    }

    #[test]
    fn transcribe_chunks_passes_through_a_single_chunk_unchanged() {
        let samples = vec![0.0f32; 50];
        let stop = not_stopped();
        let result = transcribe_chunks(&samples, 100, &stop, |chunk| {
            assert_eq!(chunk.len(), 50);
            Ok(Transcription {
                text: "hello world".into(),
                words: vec![WordSpan { text: "hello".into(), start: 0.1 }],
            })
        })
        .unwrap()
        .unwrap();
        assert_eq!(result.text, "hello world");
        assert_eq!(result.words[0].start, 0.1);
    }

    #[test]
    fn transcribe_chunks_stitches_word_offsets_across_chunk_boundaries() {
        // 250 samples chunked at 100 → chunks starting at sample 0, 100, 200.
        let samples = vec![0.0f32; 250];
        let stop = not_stopped();
        let mut call = 0;
        let result = transcribe_chunks(&samples, 100, &stop, |_chunk| {
            call += 1;
            Ok(Transcription {
                text: format!("part{call}"),
                // Each chunk reports one word at its own start (t=0 relative).
                words: vec![WordSpan { text: format!("w{call}"), start: 0.0 }],
            })
        })
        .unwrap()
        .unwrap();

        assert_eq!(result.text, "part1 part2 part3");
        let rate = TARGET_SAMPLE_RATE as f32;
        let starts: Vec<f32> = result.words.iter().map(|w| w.start).collect();
        assert_eq!(starts, vec![0.0, 100.0 / rate, 200.0 / rate]);
    }

    #[test]
    fn transcribe_chunks_skips_empty_text_parts_but_keeps_words() {
        let samples = vec![0.0f32; 10];
        let stop = not_stopped();
        let result = transcribe_chunks(&samples, 100, &stop, |_| {
            Ok(Transcription { text: "   ".into(), words: Vec::new() })
        })
        .unwrap()
        .unwrap();
        assert_eq!(result.text, "");
        assert!(result.words.is_empty());
    }

    #[test]
    fn transcribe_chunks_returns_none_when_stopped_before_decoding() {
        let samples = vec![0.0f32; 10];
        let stop = AtomicBool::new(true);
        let result = transcribe_chunks(&samples, 100, &stop, |_| {
            panic!("decode should not run once stopped");
        })
        .unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn transcribe_chunks_returns_none_partway_through_a_multi_chunk_decode() {
        let samples = vec![0.0f32; 250];
        let stop = AtomicBool::new(false);
        let mut call = 0;
        let result = transcribe_chunks(&samples, 100, &stop, |_| {
            call += 1;
            if call == 2 {
                stop.store(true, Ordering::Relaxed);
            }
            Ok(Transcription { text: format!("c{call}"), words: Vec::new() })
        })
        .unwrap();
        assert!(result.is_none(), "third chunk's stop check should short-circuit");
        assert_eq!(call, 2, "only the first two chunks decoded before cancelling");
    }
}
