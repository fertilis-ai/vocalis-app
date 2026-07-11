use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use crate::engines::{
    Diarizer, LangIdentifier, OfflineAsr, Punctuator, SourceSeparator, SpeakerEmbedder, TtsEngine,
};
use crate::pipeline::{ChatCaptureRegistry, DictationRegistry, PipelineRegistry, RecorderRegistry};

/// Cached batch-ASR engine plus the (model dir, language) it was loaded with —
/// whisper bakes the language into the recognizer, so changing either reloads.
pub struct OfflineAsrSlot {
    pub model_dir: PathBuf,
    pub language: Option<String>,
    pub engine: OfflineAsr,
}

/// Cached speaker embedding extractor plus the model dir it was loaded with.
pub struct SpeakerSlot {
    pub model_dir: PathBuf,
    pub engine: SpeakerEmbedder,
}

/// Cached diarizer plus the (segmentation, embedding) model dirs it was
/// loaded with — clustering params swap per run without a reload.
pub struct DiarizerSlot {
    pub segmentation_dir: PathBuf,
    pub embedding_dir: PathBuf,
    pub engine: Diarizer,
}

/// Cached spoken-language-ID engine plus the model dir it was loaded with.
pub struct LangIdSlot {
    pub model_dir: PathBuf,
    pub engine: LangIdentifier,
}

/// Cached punctuation-restoration engine plus the model dir it was loaded with.
pub struct PunctuatorSlot {
    pub model_dir: PathBuf,
    pub engine: Punctuator,
}

/// Cached source-separation engine plus the model dir it was loaded with.
pub struct SeparatorSlot {
    pub model_dir: PathBuf,
    pub engine: SourceSeparator,
}

/// Cached TTS engine plus the model dir it was loaded with — switching the
/// active voice's model reloads (Kokoro ⇄ Piper are different sherpa configs).
pub struct TtsSlot {
    pub model_dir: PathBuf,
    pub engine: TtsEngine,
}

/// Tauri managed state for the speech stack (spec §3.3 EngineManager).
///
/// Heavy engines load lazily on first use and stay warm; pipelines register
/// their stop flags here so stop/teardown works from any command.
#[derive(Default)]
pub struct SpeechState {
    pub tts: Mutex<Option<TtsSlot>>,
    pub punctuator: Mutex<Option<PunctuatorSlot>>,
    pub offline_asr: Mutex<Option<OfflineAsrSlot>>,
    pub speaker: Mutex<Option<SpeakerSlot>>,
    pub diarizer: Mutex<Option<DiarizerSlot>>,
    pub langid: Mutex<Option<LangIdSlot>>,
    pub separator: Mutex<Option<SeparatorSlot>>,
    pub pipelines: PipelineRegistry,
    pub dictations: DictationRegistry,
    pub chat_captures: ChatCaptureRegistry,
    pub recorders: Arc<RecorderRegistry>,
    /// True while a live transcription session runs — guards against a second
    /// concurrent session (spec §2.2B). Cleared when the session thread exits.
    pub session_active: Arc<AtomicBool>,
}

impl SpeechState {
    /// True if `model_dir` is held open by any warm engine slot or running
    /// pipeline — the model-deletion guard (spec §2.5). A path counts as in use
    /// when it lives inside (or equals) the dir being deleted, so a VAD `.onnx`
    /// held by a live ASR pipeline blocks deleting its model dir.
    pub fn model_in_use(&self, model_dir: &Path) -> bool {
        let mut held: Vec<PathBuf> = Vec::new();
        if let Some(s) = self.tts.lock().unwrap().as_ref() {
            held.push(s.model_dir.clone());
        }
        if let Some(s) = self.punctuator.lock().unwrap().as_ref() {
            held.push(s.model_dir.clone());
        }
        if let Some(s) = self.offline_asr.lock().unwrap().as_ref() {
            held.push(s.model_dir.clone());
        }
        if let Some(s) = self.speaker.lock().unwrap().as_ref() {
            held.push(s.model_dir.clone());
        }
        if let Some(s) = self.diarizer.lock().unwrap().as_ref() {
            held.push(s.segmentation_dir.clone());
            held.push(s.embedding_dir.clone());
        }
        if let Some(s) = self.langid.lock().unwrap().as_ref() {
            held.push(s.model_dir.clone());
        }
        if let Some(s) = self.separator.lock().unwrap().as_ref() {
            held.push(s.model_dir.clone());
        }
        held.extend(self.pipelines.paths_in_use());
        held.extend(self.dictations.paths_in_use());
        held.extend(self.chat_captures.paths_in_use());
        any_path_within(&held, model_dir)
    }
}

/// True if any held path equals or lives inside `model_dir`. `starts_with` is
/// component-wise, so `.../silero` never matches a sibling `.../silero-v2`.
fn any_path_within(held: &[PathBuf], model_dir: &Path) -> bool {
    held.iter().any(|p| p.starts_with(model_dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_path_within_matches_dir_and_contents() {
        let held = vec![
            PathBuf::from("/m/vad/silero/model.onnx"),
            PathBuf::from("/m/tts/kokoro"),
        ];
        // The VAD .onnx blocks deleting its model dir.
        assert!(any_path_within(&held, Path::new("/m/vad/silero")));
        // Exact dir match.
        assert!(any_path_within(&held, Path::new("/m/tts/kokoro")));
        // Sibling with a shared prefix must not match (component-wise).
        assert!(!any_path_within(&held, Path::new("/m/vad/silero-v2")));
        // Unrelated dir.
        assert!(!any_path_within(&held, Path::new("/m/asr/whisper")));
    }

    #[test]
    fn model_in_use_is_false_when_idle() {
        let state = SpeechState::default();
        assert!(!state.model_in_use(Path::new("/m/tts/kokoro")));
    }
}
