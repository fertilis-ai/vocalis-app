import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { isDesktop } from "@/lib/storage";
import { embeddingPath, usePeopleStore } from "@/stores/people-store";
import { useSettingsStore } from "@/stores/settings-store";

// Bridge to the Rust speech stack (src-tauri/src/commands/speech.rs).
// Raw audio never crosses this boundary — only events and file paths.

/**
 * Per-task active model from settings (spec §3.4 resolution: inline override
 * wins, else the configured slot, else Rust falls back to first installed).
 */
function activeModel(task: string): string | null {
  return useSettingsStore.getState().activeByTask[task] ?? null;
}

/** Preferred capture device from settings ("" = system default → null). */
function preferredInputDevice(): string | null {
  return useSettingsStore.getState().audioInputDevice || null;
}

export interface AudioInputDevice {
  name: string;
  isDefault: boolean;
  sampleRate: number;
}

export async function listAudioInputDevices(): Promise<AudioInputDevice[]> {
  if (!isDesktop()) return [];
  return invoke<AudioInputDevice[]>("audio_input_devices");
}

/** One recognized word with its start time (seconds from utterance start). */
export interface WordSpan {
  text: string;
  start: number;
}

/**
 * A finalized session turn from the live session pipeline. Mirrors the Rust
 * `SessionSegment`; the webview assigns a uuid + provisional flag when it maps
 * this into a `TranscriptSegment`.
 */
export interface SessionSegment {
  text: string;
  startMs: number;
  endMs: number;
  speakerLabel: string;
  personId: string | null;
}

export type PipelineEvent =
  | { type: "ready"; device: string; inputRate: number }
  | { type: "partial"; text: string; latencyMs: number }
  | { type: "final"; text: string; words: WordSpan[] }
  | { type: "vadState"; speaking: boolean }
  | { type: "keywordHit"; keyword: string; startTime: number }
  | { type: "level"; rms: number; peak: number }
  // Live session pipeline (spec §2.2B):
  | { type: "speakerTurn"; segment: SessionSegment }
  | { type: "processing"; message: string }
  // Batch import progress in [0,1] (spec §2.2B).
  | { type: "progress"; fraction: number }
  | { type: "refined"; segments: SessionSegment[] }
  | { type: "error"; message: string }
  | { type: "stopped" }
  // Batch import cancelled by the user before it settled (spec §2.2B) —
  // distinct from "stopped" so callers don't treat a truncated run as complete.
  | { type: "cancelled" };

export interface AsrPipelineOptions {
  asrModel?: string;
  vadModel?: string;
  onEvent: (event: PipelineEvent) => void;
}

export interface DictationPipelineOptions extends AsrPipelineOptions {
  punctuationModel?: string;
}

export async function startAsrPipeline(
  options: AsrPipelineOptions,
): Promise<number> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  const channel = new Channel<PipelineEvent>();
  channel.onmessage = options.onEvent;
  return invoke<number>("asr_pipeline_start", {
    channel,
    asrModel: options.asrModel ?? activeModel("asr-streaming"),
    vadModel: options.vadModel ?? activeModel("vad"),
    inputDevice: preferredInputDevice(),
  });
}

export async function stopAsrPipeline(id: number): Promise<void> {
  if (!isDesktop()) return;
  await invoke("asr_pipeline_stop", { id });
}

/** A webview reference to an enrolled Person for live speaker matching. */
export interface EnrolledPersonRef {
  personId: string;
  /** Path to the person's embedding.bin (Rust tilde-expands it). */
  embeddingPath: string;
}

/** Every currently-enrolled person, as session-pipeline match refs. */
export function enrolledPeopleRefs(): EnrolledPersonRef[] {
  return Object.values(usePeopleStore.getState().people)
    .map((person) => {
      const path = embeddingPath(person);
      return path ? { personId: person.id, embeddingPath: path } : null;
    })
    .filter((ref): ref is EnrolledPersonRef => ref !== null);
}

export interface SessionPipelineOptions {
  /** The session id — audio is retained under sessions/<id>/audio.wav. */
  sessionId: string;
  /** Keep the captured audio on disk for the scrubber (default true). */
  audioRetained?: boolean;
  asrModel?: string;
  vadModel?: string;
  punctuationModel?: string;
  speakerModel?: string;
  diarizationModel?: string;
  /** Enrolled people to match against; defaults to every enrolled person. */
  enrolled?: EnrolledPersonRef[];
  onEvent: (event: PipelineEvent) => void;
}

/**
 * Start a live transcription session (mic → VAD → ASR → punctuation → online
 * speaker labeling, with a stop-time diarization refinement). Turns arrive as
 * `speakerTurn` events; `stopSessionPipeline` triggers the refinement, whose
 * settled transcript arrives as a `refined` event. One session at a time.
 */
export async function startSessionPipeline(
  options: SessionPipelineOptions,
): Promise<number> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  const channel = new Channel<PipelineEvent>();
  channel.onmessage = options.onEvent;
  return invoke<number>("session_pipeline_start", {
    channel,
    sessionId: options.sessionId,
    audioRetained: options.audioRetained ?? true,
    asrModel: options.asrModel ?? activeModel("asr-streaming"),
    vadModel: options.vadModel ?? activeModel("vad"),
    punctuationModel: options.punctuationModel ?? activeModel("punctuation"),
    speakerModel: options.speakerModel ?? activeModel("speaker-embedding"),
    diarizationModel: options.diarizationModel ?? activeModel("diarization"),
    inputDevice: preferredInputDevice(),
    enrolled: options.enrolled ?? enrolledPeopleRefs(),
  });
}

export async function stopSessionPipeline(id: number): Promise<void> {
  if (!isDesktop()) return;
  await invoke("session_pipeline_stop", { id });
}

export interface ImportAudioResult {
  /** Normalized 16 kHz mono wav path (= the session's retained audio). */
  audioPath: string;
  durationMs: number;
}

/**
 * Decode an arbitrary audio file (wav/mp3/m4a/flac) to 16 kHz mono and store it
 * as the session's `audio.wav`. Both import paths consume this normalized file:
 * the local run reads it in Rust; the API path reads its bytes to upload.
 */
export async function importAudio(
  sessionId: string,
  path: string,
): Promise<ImportAudioResult> {
  if (!isDesktop()) {
    throw new Error("Importing audio requires the desktop app");
  }
  return invoke<ImportAudioResult>("import_audio", { sessionId, path });
}

export interface ImportPipelineOptions {
  sessionId: string;
  asrModel?: string;
  punctuationModel?: string;
  speakerModel?: string;
  diarizationModel?: string;
  /** Whisper language code ("en", "fr"); omit/"auto" = auto-detect. */
  language?: string;
  /** Enrolled people to match against; defaults to every enrolled person. */
  enrolled?: EnrolledPersonRef[];
  onEvent: (event: PipelineEvent) => void;
}

/**
 * Run a local batch import over the session's normalized `audio.wav`
 * (diarize → per-span batch ASR → punctuation → enrolled-Person matching).
 * Turns arrive as `speakerTurn` events, progress as `progress`, and the settled
 * transcript as `refined`, then `stopped` — the same shape the live pipeline
 * emits, so the session UI reuses one handler. Cancel with `stopImport`.
 */
export async function startImport(
  options: ImportPipelineOptions,
): Promise<number> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  const channel = new Channel<PipelineEvent>();
  channel.onmessage = options.onEvent;
  return invoke<number>("session_import", {
    channel,
    sessionId: options.sessionId,
    asrModel: options.asrModel ?? activeModel("asr-batch"),
    punctuationModel: options.punctuationModel ?? activeModel("punctuation"),
    speakerModel: options.speakerModel ?? activeModel("speaker-embedding"),
    diarizationModel: options.diarizationModel ?? activeModel("diarization"),
    language: options.language ?? null,
    enrolled: options.enrolled ?? enrolledPeopleRefs(),
  });
}

export async function stopImport(id: number): Promise<void> {
  if (!isDesktop()) return;
  await invoke("session_import_cancel", { id });
}

/** Silero knobs surfaced by the VAD tool's param panel. */
export interface VadParams {
  threshold?: number;
  minSilence?: number;
  minSpeech?: number;
}

export interface VadPipelineOptions extends VadParams {
  vadModel?: string;
  onEvent: (event: PipelineEvent) => void;
}

/** Live mic → VAD only (no ASR); stopped via stopAsrPipeline. */
export async function startVadPipeline(
  options: VadPipelineOptions,
): Promise<number> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  const channel = new Channel<PipelineEvent>();
  channel.onmessage = options.onEvent;
  return invoke<number>("vad_pipeline_start", {
    channel,
    vadModel: options.vadModel ?? activeModel("vad"),
    inputDevice: preferredInputDevice(),
    threshold: options.threshold ?? null,
    minSilence: options.minSilence ?? null,
    minSpeech: options.minSpeech ?? null,
  });
}

export interface VadSegment {
  start: number;
  end: number;
}

export interface VadAnalysis {
  durationSecs: number;
  segments: VadSegment[];
}

/** Offline VAD over a wav file — the VAD tool's file mode. */
export async function vadAnalyzeFile(
  path: string,
  params: VadParams & { vadModel?: string } = {},
): Promise<VadAnalysis> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  return invoke<VadAnalysis>("vad_analyze_file", {
    path,
    vadModel: params.vadModel ?? activeModel("vad"),
    threshold: params.threshold ?? null,
    minSilence: params.minSilence ?? null,
    minSpeech: params.minSpeech ?? null,
  });
}

export interface TranscribeFileResult {
  text: string;
  /** Word timestamps; empty when the model reports none (stock whisper). */
  words: WordSpan[];
  durationSecs: number;
  processingMs: number;
  /** Real-time factor: processing time / audio duration (lower is faster). */
  rtf: number;
}

/** Batch-transcribe a wav with offline Whisper — the ASR bench's file mode. */
export async function asrTranscribeFile(
  path: string,
  options: { model?: string; language?: string } = {},
): Promise<TranscribeFileResult> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  return invoke<TranscribeFileResult>("asr_transcribe_file", {
    path,
    model: options.model ?? activeModel("asr-batch"),
    language: options.language ?? null,
  });
}

/** Run the streaming Zipformer over a whole wav — engine-compare mode. */
export async function asrTranscribeFileStreaming(
  path: string,
  options: { model?: string } = {},
): Promise<TranscribeFileResult> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  return invoke<TranscribeFileResult>("asr_transcribe_file_streaming", {
    path,
    model: options.model ?? activeModel("asr-streaming"),
  });
}

/** Punctuate arbitrary text (playground). Missing model is an error here. */
export async function punctuateText(
  text: string,
  model = activeModel("punctuation"),
): Promise<string> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  return invoke<string>("punctuate_text", { text, model });
}

export interface SpeakerCompareResult {
  /** Cosine similarity of the two clips' embeddings, in [-1, 1]. */
  similarity: number;
  isMatch: boolean;
  threshold: number;
  embeddingDim: number;
  processingMs: number;
}

/** Speaker verification: are two clips the same voice? */
export async function speakerCompareFiles(
  pathA: string,
  pathB: string,
  options: { model?: string; threshold?: number } = {},
): Promise<SpeakerCompareResult> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  return invoke<SpeakerCompareResult>("speaker_compare_files", {
    pathA,
    pathB,
    model: options.model ?? activeModel("speaker-embedding"),
    threshold: options.threshold ?? null,
  });
}

export interface EnrolledClip {
  name: string;
  path: string;
}

export interface SpeakerScore {
  name: string;
  score: number;
  isMatch: boolean;
}

export interface SpeakerIdentifyResult {
  /** Every enrolled speaker, ranked by score. */
  scores: SpeakerScore[];
  /** Best matching name, if any score cleared the threshold. */
  best: string | null;
  threshold: number;
  processingMs: number;
}

/** Speaker identification: who (of the enrolled clips) speaks in `path`? */
export async function speakerIdentifyFile(
  path: string,
  enrolled: EnrolledClip[],
  options: { model?: string; threshold?: number } = {},
): Promise<SpeakerIdentifyResult> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  return invoke<SpeakerIdentifyResult>("speaker_identify_file", {
    path,
    enrolled,
    model: options.model ?? activeModel("speaker-embedding"),
    threshold: options.threshold ?? null,
  });
}

export interface DiarizationSegment {
  start: number;
  end: number;
  /** Clustered speaker label — not necessarily contiguous from 0. */
  speaker: number;
}

export interface DiarizeFileResult {
  durationSecs: number;
  processingMs: number;
  numSpeakers: number;
  segments: DiarizationSegment[];
}

/** Offline diarization: who spoke when. numSpeakers 0/undefined = auto. */
export async function diarizeFile(
  path: string,
  options: {
    model?: string;
    embeddingModel?: string;
    numSpeakers?: number;
    threshold?: number;
  } = {},
): Promise<DiarizeFileResult> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  return invoke<DiarizeFileResult>("diarize_file", {
    path,
    model: options.model ?? activeModel("diarization"),
    embeddingModel: options.embeddingModel ?? activeModel("speaker-embedding"),
    numSpeakers: options.numSpeakers ?? null,
    threshold: options.threshold ?? null,
  });
}

export interface KeywordHit {
  keyword: string;
  /** Seconds of audio processed when the keyword fired. */
  startTime: number;
}

export interface KwsPipelineOptions {
  /** Newline-joined keyword list; empty uses the model's bundled keywords. */
  keywords: string;
  keywordsScore?: number;
  model?: string;
  onEvent: (event: PipelineEvent) => void;
}

/** Live mic → keyword spotter; stopped via stopAsrPipeline. */
export async function startKwsPipeline(
  options: KwsPipelineOptions,
): Promise<number> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  const channel = new Channel<PipelineEvent>();
  channel.onmessage = options.onEvent;
  return invoke<number>("kws_pipeline_start", {
    channel,
    keywords: options.keywords,
    keywordsScore: options.keywordsScore ?? null,
    model: options.model ?? activeModel("kws"),
    inputDevice: preferredInputDevice(),
  });
}

export interface KwsDefaults {
  /** Bundled keywords in tokenized BPE form (what the engine consumes). */
  tokens: string;
  /** The same keywords as human phrases, aligned line for line ("" if none). */
  phrases: string;
}

/** The KWS model's bundled tokenized keyword list, to seed the tool's editor. */
export async function kwsDefaultKeywords(
  model = activeModel("kws"),
): Promise<KwsDefaults> {
  if (!isDesktop()) return { tokens: "", phrases: "" };
  return invoke<KwsDefaults>("kws_default_keywords", { model });
}

export interface KwsAnalysis {
  durationSecs: number;
  hits: KeywordHit[];
}

/** Offline keyword spotting over a wav — the KWS tool's file mode. */
export async function kwsAnalyzeFile(
  path: string,
  options: { keywords: string; keywordsScore?: number; model?: string },
): Promise<KwsAnalysis> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  return invoke<KwsAnalysis>("kws_analyze_file", {
    path,
    keywords: options.keywords,
    keywordsScore: options.keywordsScore ?? null,
    model: options.model ?? activeModel("kws"),
  });
}

export interface LangIdResult {
  /** ISO 639-1 code whisper reports (e.g. "en", "fr"). */
  lang: string;
  processingMs: number;
}

/** Identify the spoken language of a wav — the language-ID tool. */
export async function langidFile(
  path: string,
  options: { model?: string } = {},
): Promise<LangIdResult> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  return invoke<LangIdResult>("langid_file", {
    path,
    model: options.model ?? activeModel("lang-id"),
  });
}

export interface SeparatedStemInfo {
  /** Stem label ("vocals" / "accompaniment" for Spleeter 2-stems). */
  name: string;
  wavPath: string;
  durationSecs: number;
}

export interface SeparateResult {
  stems: SeparatedStemInfo[];
  processingMs: number;
}

/** Offline source separation over a wav — file input only (spec §2.3). */
export async function separateFile(
  path: string,
  options: { model?: string } = {},
): Promise<SeparateResult> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  return invoke<SeparateResult>("separate_file", {
    path,
    model: options.model ?? activeModel("separation"),
  });
}

export type RecorderEvent =
  | { type: "ready"; device: string; inputRate: number }
  | { type: "level"; rms: number; peak: number }
  | { type: "saved"; path: string; durationSecs: number }
  | { type: "cancelled" }
  | { type: "error"; message: string };

/** Record a bench clip; the saved wav path arrives as a `saved` event. */
export async function startRecording(
  onEvent: (event: RecorderEvent) => void,
): Promise<number> {
  if (!isDesktop()) {
    throw new Error("Recording requires the desktop app");
  }
  const channel = new Channel<RecorderEvent>();
  channel.onmessage = onEvent;
  return invoke<number>("record_start", {
    channel,
    inputDevice: preferredInputDevice(),
  });
}

export async function stopRecording(id: number): Promise<void> {
  if (!isDesktop()) return;
  await invoke("record_stop", { id });
}

/**
 * Record an enrollment clip for a Person into
 * people/<id>/enrollment/clip-<slot>.wav. Reuses the bench recorder — stop with
 * `stopRecording`, cancel with `cancelRecording`; the saved path arrives as a
 * `saved` event.
 */
export async function startEnrollmentRecording(
  personId: string,
  slot: number,
  onEvent: (event: RecorderEvent) => void,
): Promise<number> {
  if (!isDesktop()) {
    throw new Error("Recording requires the desktop app");
  }
  const channel = new Channel<RecorderEvent>();
  channel.onmessage = onEvent;
  return invoke<number>("enroll_record_start", {
    channel,
    personId,
    slot,
    inputDevice: preferredInputDevice(),
  });
}

export interface EnrollResult {
  /** Relative to the person dir — always "embedding.bin". */
  embeddingPath: string;
  embeddingDim: number;
}

/**
 * Build a Person's enrollment embedding from recorded clips (absolute wav
 * paths): embed each, average, and write people/<id>/embedding.bin. Returns the
 * embedding path + dim for profile.json.
 */
export async function enrollPerson(
  personId: string,
  clips: string[],
  model = activeModel("speaker-embedding"),
): Promise<EnrollResult> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  return invoke<EnrollResult>("enroll_person", { personId, clips, model });
}

export async function cancelRecording(id: number): Promise<void> {
  if (!isDesktop()) return;
  await invoke("record_cancel", { id });
}

export interface AudioFileInfo {
  durationSecs: number;
  sampleRate: number;
}

export async function audioFileInfo(path: string): Promise<AudioFileInfo | null> {
  if (!isDesktop()) return null;
  return invoke<AudioFileInfo>("audio_file_info", { path });
}

export async function startDictation(
  options: DictationPipelineOptions,
): Promise<number> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  const channel = new Channel<PipelineEvent>();
  channel.onmessage = options.onEvent;
  return invoke<number>("dictation_start", {
    channel,
    asrModel: options.asrModel ?? activeModel("asr-streaming"),
    vadModel: options.vadModel ?? activeModel("vad"),
    inputDevice: preferredInputDevice(),
  });
}

export async function finalizeDictation(
  id: number,
  punctuationModel = activeModel("punctuation"),
): Promise<string> {
  if (!isDesktop()) return "";
  return invoke<string>("dictation_finalize", { id, punctuationModel });
}

export async function cancelDictation(id: number): Promise<void> {
  if (!isDesktop()) return;
  await invoke("dictation_cancel", { id });
}

export interface InjectionResult {
  injected: boolean;
  copied: boolean;
  accessibilityTrusted: boolean;
}

export async function injectText(text: string): Promise<InjectionResult> {
  if (!isDesktop()) {
    return { injected: false, copied: false, accessibilityTrusted: false };
  }
  return invoke<InjectionResult>("inject_text", { text });
}

export interface TtsResult {
  path: string;
  durationSecs: number;
  cached: boolean;
}

export interface TtsOptions {
  speakerId?: number;
  speed?: number;
  model?: string;
}

export async function ttsSynthesize(
  text: string,
  options: TtsOptions = {},
): Promise<TtsResult> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  return invoke<TtsResult>("tts_synthesize", {
    text,
    speakerId: options.speakerId ?? null,
    speed: options.speed ?? null,
    model: options.model ?? activeModel("tts"),
    maxCacheBytes: useSettingsStore.getState().ttsCacheMaxBytes,
  });
}

/** Copy a synthesized wav into the bench recording library; returns new path. */
export async function ttsSaveToLibrary(
  path: string,
  label?: string,
): Promise<string> {
  if (!isDesktop()) {
    throw new Error("Local speech engines require the desktop app");
  }
  return invoke<string>("tts_save_to_library", { path, label: label ?? null });
}

/** Current size of the TTS cache in bytes (for the storage meter). */
export async function ttsCacheSize(): Promise<number> {
  if (!isDesktop()) return 0;
  return invoke<number>("tts_cache_size");
}

/** Evict the TTS cache down to the configured cap. API adapters write into
 * the cache dir directly, bypassing the local-synth path's eviction. */
export async function ttsCacheEvict(): Promise<void> {
  if (!isDesktop()) return;
  await invoke("tts_cache_evict", {
    maxCacheBytes: useSettingsStore.getState().ttsCacheMaxBytes,
  });
}

/** Convert a local wav path into a webview-playable URL (asset protocol). */
export function audioUrl(path: string): string {
  return convertFileSrc(path);
}
