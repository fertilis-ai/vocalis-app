use std::path::Path;

use serde::Serialize;
use sherpa_onnx::{
    OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig,
    OfflineWhisperModelConfig,
};

use crate::registry::find_file;

/// One recognized word with its start time (seconds from utterance start).
#[derive(Clone, Serialize)]
pub struct WordSpan {
    pub text: String,
    pub start: f32,
}

/// Text plus word-level timing — returned by both batch and streaming
/// file transcription so the bench can render them identically.
#[derive(Clone, Serialize)]
pub struct Transcription {
    pub text: String,
    pub words: Vec<WordSpan>,
}

/// Merge BPE tokens + per-token timestamps into words. Whisper tokens mark
/// word starts with a leading space, zipformer tokens with '▁' (sentencepiece);
/// a token carrying neither continues the previous word.
pub fn merge_tokens_into_words(tokens: &[String], timestamps: Option<&[f32]>) -> Vec<WordSpan> {
    let Some(timestamps) = timestamps else {
        return Vec::new();
    };
    let mut words: Vec<WordSpan> = Vec::new();
    for (token, &start) in tokens.iter().zip(timestamps) {
        let starts_word = token.starts_with(' ') || token.starts_with('▁');
        let piece = token.trim_start_matches([' ', '▁']);
        if piece.is_empty() {
            continue;
        }
        match words.last_mut() {
            Some(last) if !starts_word => last.text.push_str(piece),
            _ => words.push(WordSpan {
                text: piece.to_string(),
                start,
            }),
        }
    }
    words
}

/// Offline Whisper recognizer (spec §3.3 `OfflineAsr`) — batch file
/// transcription for imports and the playground ASR bench.
pub struct OfflineAsr {
    recognizer: OfflineRecognizer,
}

impl OfflineAsr {
    /// `model_dir` must contain encoder/decoder .onnx + a tokens .txt
    /// (standard k2-fsa whisper release layout; int8 preferred by find_file's
    /// sort) — or, for a NeMo transducer release (e.g. Parakeet TDT), an
    /// additional joiner .onnx, which selects that model type instead.
    /// `language` is a whisper code ("en", "fr") and is ignored for
    /// transducer models (language comes from the BPE vocab); None = auto-detect.
    pub fn new(model_dir: &Path, num_threads: i32, language: Option<&str>) -> Result<Self, String> {
        let missing = |what: &str| format!("{what} not found in {}", model_dir.display());
        let encoder = find_file(model_dir, "encoder", ".onnx").ok_or_else(|| missing("encoder"))?;
        let decoder = find_file(model_dir, "decoder", ".onnx").ok_or_else(|| missing("decoder"))?;
        let tokens = find_file(model_dir, "tokens", ".txt").ok_or_else(|| missing("tokens"))?;
        let joiner = find_file(model_dir, "joiner", ".onnx");

        let mut config = OfflineRecognizerConfig::default();
        if let Some(joiner) = joiner {
            config.model_config.transducer = OfflineTransducerModelConfig {
                encoder: Some(encoder.to_string_lossy().into_owned()),
                decoder: Some(decoder.to_string_lossy().into_owned()),
                joiner: Some(joiner.to_string_lossy().into_owned()),
            };
            config.model_config.model_type = Some("nemo_transducer".into());
        } else {
            config.model_config.whisper = OfflineWhisperModelConfig {
                encoder: Some(encoder.to_string_lossy().into_owned()),
                decoder: Some(decoder.to_string_lossy().into_owned()),
                language: language.map(str::to_owned),
                task: Some("transcribe".into()),
                tail_paddings: -1,
                enable_token_timestamps: true,
                enable_segment_timestamps: false,
            };
        }
        config.model_config.tokens = Some(tokens.to_string_lossy().into_owned());
        config.model_config.num_threads = num_threads;
        config.model_config.provider = Some("cpu".into());
        config.decoding_method = Some("greedy_search".into());

        let recognizer = OfflineRecognizer::create(&config)
            .ok_or_else(|| format!("failed to load batch ASR model {}", model_dir.display()))?;
        Ok(Self { recognizer })
    }

    /// Transcribe 16 kHz mono samples in one pass.
    pub fn transcribe(&self, samples: &[f32]) -> Result<Transcription, String> {
        let stream = self.recognizer.create_stream();
        stream.accept_waveform(crate::audio::TARGET_SAMPLE_RATE as i32, samples);
        self.recognizer.decode(&stream);
        let result = stream.get_result().ok_or("batch ASR produced no result")?;
        let words = merge_tokens_into_words(&result.tokens, result.timestamps.as_deref());
        Ok(Transcription {
            text: result.text.trim().to_string(),
            words,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::merge_tokens_into_words;

    fn tokens(list: &[&str]) -> Vec<String> {
        list.iter().map(|t| t.to_string()).collect()
    }

    #[test]
    fn merges_whisper_space_prefixed_tokens_into_words() {
        let words = merge_tokens_into_words(
            &tokens(&[" after", " early", " night", "fall"]),
            Some(&[0.0, 0.4, 0.8, 1.1]),
        );
        let texts: Vec<&str> = words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, ["after", "early", "nightfall"]);
        assert_eq!(words[2].start, 0.8, "word keeps its first token's start");
    }

    #[test]
    fn merges_sentencepiece_tokens_and_skips_empty_markers() {
        let words = merge_tokens_into_words(
            &tokens(&["▁HE", "LLO", "▁", "▁WORLD"]),
            Some(&[0.1, 0.2, 0.3, 0.5]),
        );
        let texts: Vec<&str> = words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, ["HELLO", "WORLD"]);
    }

    #[test]
    fn missing_timestamps_yield_no_words() {
        assert!(merge_tokens_into_words(&tokens(&[" hi"]), None).is_empty());
    }

    #[test]
    fn leading_continuation_token_still_starts_a_word() {
        let words = merge_tokens_into_words(&tokens(&["hi", " there"]), Some(&[0.0, 0.3]));
        let texts: Vec<&str> = words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, ["hi", "there"]);
    }
}
