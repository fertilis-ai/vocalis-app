use std::path::Path;

use sherpa_onnx::{OfflinePunctuation, OfflinePunctuationConfig};

use crate::registry;

/// CT-Transformer punctuation restorer (spec §3.3, catalog task
/// "punctuation"). One loaded instance is shared via the EngineManager;
/// dictation applies it to the raw ASR transcript at finalize.
pub struct Punctuator {
    punct: OfflinePunctuation,
}

impl Punctuator {
    /// `model_dir` = ct-transformer release layout: model.onnx (+ tokens.json).
    pub fn new(model_dir: &Path, num_threads: i32) -> Result<Self, String> {
        let model = registry::find_file(model_dir, "model", ".onnx")
            .ok_or_else(|| format!("no model .onnx in {}", model_dir.display()))?;

        let mut config = OfflinePunctuationConfig::default();
        config.model.ct_transformer = Some(model.to_string_lossy().into_owned());
        config.model.num_threads = num_threads;

        let punct = OfflinePunctuation::create(&config)
            .ok_or_else(|| format!("failed to load punctuation model {}", model_dir.display()))?;
        Ok(Self { punct })
    }

    /// Punctuate a raw transcript. Empty/whitespace input passes through, and
    /// a model failure falls back to the raw text rather than erroring — a
    /// missing comma must never lose a dictation.
    pub fn punctuate(&self, text: &str) -> String {
        if text.trim().is_empty() {
            return text.to_string();
        }
        match self.punct.add_punctuation(text) {
            Some(out) => normalize_fullwidth(&out),
            None => text.to_string(),
        }
    }

    /// Pipeline variant: skip the model when the ASR engine already
    /// punctuated its output (Whisper, Parakeet, Nemotron, …) — spec §2.2B
    /// "+ punctuation if the engine leaves none". Re-punctuating cased,
    /// punctuated text doubles marks, and the zh/en model mangles French.
    pub fn punctuate_if_needed(&self, text: &str) -> String {
        if has_sentence_punctuation(text) {
            return text.to_string();
        }
        self.punctuate(text)
    }
}

/// Whether text already carries sentence punctuation, so the punctuator can be
/// skipped. Covers both ASCII and CJK/French terminal marks.
pub fn has_sentence_punctuation(text: &str) -> bool {
    text.chars()
        .any(|c| matches!(c, '.' | ',' | '!' | '?' | ';' | ':' | '。' | '，' | '！' | '？' | '、'))
}

/// The zh-en CT-Transformer emits full-width CJK marks (。，？！) even on
/// English text — map them to ASCII with a trailing space where one is due.
fn normalize_fullwidth(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let ascii = match c {
            '。' => Some('.'),
            '，' | '、' => Some(','),
            '？' => Some('?'),
            '！' => Some('!'),
            '：' => Some(':'),
            '；' => Some(';'),
            _ => None,
        };
        match ascii {
            Some(a) => {
                out.push(a);
                if chars.peek().is_some_and(|n| n.is_alphanumeric()) {
                    out.push(' ');
                }
            }
            None => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{has_sentence_punctuation, normalize_fullwidth};

    #[test]
    fn punctuation_detection() {
        assert!(has_sentence_punctuation("Hello, world."));
        assert!(has_sentence_punctuation("really?"));
        assert!(!has_sentence_punctuation("hello world"));
        assert!(!has_sentence_punctuation("no marks here"));
    }

    #[test]
    fn maps_cjk_marks_to_ascii_with_spacing() {
        assert_eq!(
            normalize_fullwidth("today is a good day。how are you？"),
            "today is a good day. how are you?"
        );
        assert_eq!(normalize_fullwidth("one，two，three。"), "one, two, three.");
        assert_eq!(
            normalize_fullwidth("already ascii. fine?"),
            "already ascii. fine?"
        );
    }
}
