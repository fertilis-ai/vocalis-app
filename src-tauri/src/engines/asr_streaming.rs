use std::path::Path;

use sherpa_onnx::{
    OnlineModelConfig, OnlineRecognizer, OnlineRecognizerConfig, OnlineStream,
    OnlineTransducerModelConfig,
};

use crate::engines::{merge_tokens_into_words, Transcription};
use crate::registry::find_file;

/// Streaming Zipformer transducer session (spec §3.3 `StreamingAsr`).
pub struct StreamingAsrSession {
    recognizer: OnlineRecognizer,
    stream: OnlineStream,
    last_text: String,
}

impl StreamingAsrSession {
    /// `model_dir` must contain encoder/decoder/joiner .onnx + tokens.txt
    /// (standard k2-fsa streaming-zipformer release layout; int8 preferred —
    /// find_file's sort puts `.int8.onnx` before `.onnx`).
    pub fn new(model_dir: &Path, num_threads: i32) -> Result<Self, String> {
        let missing = |what: &str| format!("{what} not found in {}", model_dir.display());
        let encoder = find_file(model_dir, "encoder", ".onnx").ok_or_else(|| missing("encoder"))?;
        let decoder = find_file(model_dir, "decoder", ".onnx").ok_or_else(|| missing("decoder"))?;
        let joiner = find_file(model_dir, "joiner", ".onnx").ok_or_else(|| missing("joiner"))?;
        let tokens = model_dir.join("tokens.txt");
        if !tokens.exists() {
            return Err(missing("tokens.txt"));
        }

        let config = OnlineRecognizerConfig {
            model_config: OnlineModelConfig {
                transducer: OnlineTransducerModelConfig {
                    encoder: Some(encoder.to_string_lossy().into_owned()),
                    decoder: Some(decoder.to_string_lossy().into_owned()),
                    joiner: Some(joiner.to_string_lossy().into_owned()),
                },
                tokens: Some(tokens.to_string_lossy().into_owned()),
                num_threads,
                provider: Some("cpu".into()),
                debug: false,
                ..Default::default()
            },
            decoding_method: Some("greedy_search".into()),
            enable_endpoint: true,
            // Endpoint rules: trailing silence after speech (rule2) fires most
            // finals; rule1 covers silence-only starts; rule3 caps utterances.
            rule1_min_trailing_silence: 2.4,
            rule2_min_trailing_silence: 0.9,
            rule3_min_utterance_length: 30.0,
            ..Default::default()
        };

        let recognizer = OnlineRecognizer::create(&config)
            .ok_or_else(|| format!("failed to load ASR model {}", model_dir.display()))?;
        let stream = recognizer.create_stream();

        Ok(Self {
            recognizer,
            stream,
            last_text: String::new(),
        })
    }

    /// Feed 16 kHz mono samples; returns Some(partial_text) when it changed.
    pub fn push(&mut self, samples: &[f32]) -> Option<String> {
        self.stream
            .accept_waveform(crate::audio::TARGET_SAMPLE_RATE as i32, samples);
        while self.recognizer.is_ready(&self.stream) {
            self.recognizer.decode(&self.stream);
        }
        let text = self
            .recognizer
            .get_result(&self.stream)
            .map(|r| r.text)
            .unwrap_or_default();
        if !text.is_empty() && text != self.last_text {
            self.last_text = text.clone();
            Some(text)
        } else {
            None
        }
    }

    /// Endpoint reached? If so, returns the final segment (text + word
    /// timestamps relative to the utterance start) and resets the stream.
    pub fn take_final(&mut self) -> Option<Transcription> {
        if !self.recognizer.is_endpoint(&self.stream) {
            return None;
        }
        let words = self
            .recognizer
            .get_result(&self.stream)
            .map(|r| merge_tokens_into_words(&r.tokens, r.timestamps.as_deref()))
            .unwrap_or_default();
        let text = std::mem::take(&mut self.last_text);
        self.recognizer.reset(&self.stream);
        (!text.is_empty()).then_some(Transcription { text, words })
    }

    /// Return the in-progress recognition result when capture ends. Unlike an
    /// endpoint final this does not require trailing silence, which is needed
    /// for push-to-talk dictation where releasing the key ends an utterance.
    pub fn finish(&mut self) -> Option<String> {
        let text = std::mem::take(&mut self.last_text);
        self.recognizer.reset(&self.stream);
        (!text.trim().is_empty()).then_some(text)
    }

    /// Run the streaming recognizer over a whole clip in one pass — the ASR
    /// bench's engine-compare mode (same wav through streaming and batch
    /// engines). Uses a fresh stream so a live session is never disturbed.
    pub fn transcribe_file(&self, samples: &[f32]) -> Result<Transcription, String> {
        let stream = self.recognizer.create_stream();
        stream.accept_waveform(crate::audio::TARGET_SAMPLE_RATE as i32, samples);
        stream.input_finished();
        while self.recognizer.is_ready(&stream) {
            self.recognizer.decode(&stream);
        }
        let result = self
            .recognizer
            .get_result(&stream)
            .ok_or("streaming ASR produced no result")?;
        let words = merge_tokens_into_words(&result.tokens, result.timestamps.as_deref());
        Ok(Transcription {
            text: result.text.trim().to_string(),
            words,
        })
    }
}
