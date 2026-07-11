use std::path::Path;

use serde::Serialize;
use sherpa_onnx::{
    KeywordSpotter, KeywordSpotterConfig, OnlineModelConfig, OnlineStream,
    OnlineTransducerModelConfig,
};

/// Keyword list a session detects: either explicit tokenized lines from the UI,
/// or the model's bundled `keywords.txt` when the UI list is empty.
enum Keywords<'a> {
    Buf(&'a str),
    BundledFile(String),
}

use crate::registry::find_file;

/// One keyword detection, with its start time in seconds from the clip/stream
/// start.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeywordHit {
    pub keyword: String,
    pub start_time: f32,
}

/// Streaming keyword spotter (catalog task "kws") wrapping sherpa's Zipformer
/// `KeywordSpotter`. Loaded once with a model + boost, then bound to a keyword
/// list per session (`create`).
///
/// Keywords come from the UI as plain lines, optionally with sherpa's per-line
/// `:boost` / `#threshold` / `@phrase` syntax. When the model ships a BPE vocab
/// (`bpe.vocab`), the spotter tokenizes plain English words itself; otherwise
/// the lines must already be space-separated tokens (documented in the tool).
pub struct KeywordSession {
    spotter: KeywordSpotter,
    stream: OnlineStream,
}

impl KeywordSession {
    /// `model_dir` is a k2-fsa KWS release (encoder/decoder/joiner .onnx +
    /// tokens.txt, plus an optional bpe.vocab). `keywords` is the newline-joined
    /// keyword list; empty falls back to the model's bundled keywords file.
    pub fn new(
        model_dir: &Path,
        num_threads: i32,
        keywords_score: f32,
        keywords: &str,
    ) -> Result<Self, String> {
        let missing = |what: &str| format!("{what} not found in {}", model_dir.display());
        let encoder = find_file(model_dir, "encoder", ".onnx").ok_or_else(|| missing("encoder"))?;
        let decoder = find_file(model_dir, "decoder", ".onnx").ok_or_else(|| missing("decoder"))?;
        let joiner = find_file(model_dir, "joiner", ".onnx").ok_or_else(|| missing("joiner"))?;
        let tokens = model_dir.join("tokens.txt");
        if !tokens.exists() {
            return Err(missing("tokens.txt"));
        }
        // A bundled bpe vocab lets sherpa tokenize plain-text keywords; without
        // it the caller must supply pre-tokenized keyword lines.
        let bpe_vocab = find_file(model_dir, "bpe", ".vocab");

        // sherpa validates that keywords are present at creation (via file or
        // buffer) — an empty UI list falls back to the model's keywords.txt.
        let keywords = if keywords.trim().is_empty() {
            let bundled = model_dir.join("keywords.txt");
            if !bundled.exists() {
                return Err(format!(
                    "no keywords given and no bundled keywords.txt in {}",
                    model_dir.display()
                ));
            }
            Keywords::BundledFile(bundled.to_string_lossy().into_owned())
        } else {
            Keywords::Buf(keywords)
        };

        let config = KeywordSpotterConfig {
            model_config: OnlineModelConfig {
                transducer: OnlineTransducerModelConfig {
                    encoder: Some(encoder.to_string_lossy().into_owned()),
                    decoder: Some(decoder.to_string_lossy().into_owned()),
                    joiner: Some(joiner.to_string_lossy().into_owned()),
                },
                tokens: Some(tokens.to_string_lossy().into_owned()),
                num_threads,
                provider: Some("cpu".into()),
                modeling_unit: bpe_vocab.as_ref().map(|_| "bpe".to_string()),
                bpe_vocab: bpe_vocab.map(|p| p.to_string_lossy().into_owned()),
                ..Default::default()
            },
            keywords_score,
            keywords_file: match &keywords {
                Keywords::BundledFile(path) => Some(path.clone()),
                Keywords::Buf(_) => None,
            },
            keywords_buf: match &keywords {
                Keywords::Buf(text) => Some((*text).to_string()),
                Keywords::BundledFile(_) => None,
            },
            ..Default::default()
        };

        let spotter = KeywordSpotter::create(&config)
            .ok_or_else(|| format!("failed to load KWS model {}", model_dir.display()))?;
        let stream = spotter.create_stream();
        Ok(Self { spotter, stream })
    }

    /// Feed 16 kHz mono samples; returns any keywords that fired in this chunk.
    pub fn push(&self, samples: &[f32]) -> Vec<KeywordHit> {
        self.stream
            .accept_waveform(crate::audio::TARGET_SAMPLE_RATE as i32, samples);
        self.drain()
    }

    /// Flush trailing audio at end-of-clip and return any final detections.
    pub fn finish(&self) -> Vec<KeywordHit> {
        self.stream.input_finished();
        self.drain()
    }

    fn drain(&self) -> Vec<KeywordHit> {
        let mut hits = Vec::new();
        while self.spotter.is_ready(&self.stream) {
            self.spotter.decode(&self.stream);
            if let Some(result) = self.spotter.get_result(&self.stream) {
                if !result.keyword.is_empty() {
                    hits.push(KeywordHit {
                        keyword: result.keyword,
                        start_time: result.start_time,
                    });
                    // Reset so the same keyword can fire again later.
                    self.spotter.reset(&self.stream);
                }
            }
        }
        hits
    }
}

/// Offline keyword spotting over a whole 16 kHz mono clip — the KWS tool's file
/// mode. Feeds the clip in chunks through the online spotter so multiple
/// detections across the file are all captured with their timestamps.
pub fn spot_keywords_in_clip(
    model_dir: &Path,
    num_threads: i32,
    keywords_score: f32,
    keywords: &str,
    samples: &[f32],
) -> Result<Vec<KeywordHit>, String> {
    let session = KeywordSession::new(model_dir, num_threads, keywords_score, keywords)?;
    let mut hits = Vec::new();
    // 100 ms chunks at 16 kHz, matching the live pipeline's cadence.
    for chunk in samples.chunks(1600) {
        hits.extend(session.push(chunk));
    }
    hits.extend(session.finish());
    Ok(hits)
}
