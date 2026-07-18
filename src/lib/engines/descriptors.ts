// Engine descriptors — pure data, spec §3.4. One entry per (task, engine);
// the router (lib/routing/engine-router.ts) resolves which one is active and
// why the others aren't. Local descriptors point at a model-registry task
// whose active slot (settings.activeByTask) names the concrete model; API
// descriptors name a provider whose key must exist in the keychain.

/** Routed speech tasks. The first five are hybrid (config routing: map); the
 *  rest are local-only in v1 and have no config entry. */
export const SPEECH_TASKS = [
  "streamingAsr",
  "batchAsr",
  "tts",
  "cloneTts",
  "diarization",
  "vad",
  "speakerId",
  "speakerVerify",
  "punctuation",
  "kws",
  "separation",
  "langId",
] as const;

export type SpeechTask = (typeof SPEECH_TASKS)[number];

export const TASK_LABELS: Record<SpeechTask, string> = {
  streamingAsr: "Streaming recognition",
  batchAsr: "Batch recognition",
  tts: "Speech synthesis",
  cloneTts: "Cloned-voice synthesis",
  diarization: "Speaker diarization",
  vad: "Voice activity detection",
  speakerId: "Speaker identification",
  speakerVerify: "Speaker verification",
  punctuation: "Punctuation",
  kws: "Keyword spotting",
  separation: "Source separation",
  langId: "Spoken language ID",
};

export type ApiProvider = "openai" | "groq" | "elevenlabs" | "deepgram";

export const PROVIDER_LABELS: Record<ApiProvider, string> = {
  openai: "OpenAI",
  groq: "Groq",
  elevenlabs: "ElevenLabs",
  deepgram: "Deepgram",
};

/** One knob on an engine's parameter surface, rendered schema-driven by the
 *  bench ParamPanel (spec §2.3). Values live in run params keyed by `key`. */
export type ParamSpec =
  | {
      key: string;
      label: string;
      type: "number";
      min: number;
      max: number;
      step: number;
      default: number;
      /** Display suffix, e.g. "s" or "×" */
      unit?: string;
    }
  | { key: string; label: string; type: "boolean"; default: boolean }
  | {
      key: string;
      label: string;
      type: "select";
      options: { value: string; label: string }[];
      default: string;
    };

export interface EngineDescriptor {
  /** Stable id, also the value stored in config routing (e.g. "local.kokoro-en") */
  id: string;
  task: SpeechTask;
  kind: "local" | "api";
  /** API engines: keychain provider whose key gates eligibility */
  provider?: ApiProvider;
  /** Local engines: model-registry task whose active slot serves this engine */
  modelTask?: string;
  label: string;
  langs: string[];
  /**
   * Whether the runtime path behind this engine exists yet. Engines land one
   * capability at a time through M2 (plan §M2.4–9); unimplemented ones stay
   * visible in pickers but unpickable, so routing never points at dead code.
   */
  implemented: boolean;
  /** Schema-driven parameter surface for the bench ParamPanel. */
  params?: ParamSpec[];
}

/** Initial param values for an engine (its ParamPanel defaults). */
export function defaultParams(engine: EngineDescriptor): Record<string, unknown> {
  return Object.fromEntries(
    (engine.params ?? []).map((spec) => [spec.key, spec.default]),
  );
}

export const ENGINE_DESCRIPTORS: EngineDescriptor[] = [
  // Streaming ASR — dictation / live sessions / chat capture
  {
    id: "local.zipformer-en",
    task: "streamingAsr",
    kind: "local",
    modelTask: "asr-streaming",
    label: "Zipformer (local)",
    langs: ["en"],
    implemented: true,
  },
  {
    id: "deepgram.nova",
    task: "streamingAsr",
    kind: "api",
    provider: "deepgram",
    label: "Deepgram Nova",
    langs: ["en", "fr"],
    implemented: false,
  },

  // Batch ASR — file imports
  {
    id: "local.whisper-small",
    task: "batchAsr",
    kind: "local",
    modelTask: "asr-batch",
    label: "Whisper small (local)",
    langs: ["en", "fr"],
    implemented: true,
    params: [
      {
        key: "language",
        label: "Language",
        type: "select",
        options: [
          { value: "auto", label: "Auto-detect" },
          { value: "en", label: "English" },
          { value: "fr", label: "French" },
        ],
        default: "auto",
      },
    ],
  },
  {
    id: "groq.whisper-large-v3",
    task: "batchAsr",
    kind: "api",
    provider: "groq",
    label: "Groq Whisper large-v3",
    langs: ["en", "fr"],
    implemented: true,
  },
  {
    id: "openai.whisper-1",
    task: "batchAsr",
    kind: "api",
    provider: "openai",
    label: "OpenAI Whisper",
    langs: ["en", "fr"],
    implemented: true,
  },
  {
    id: "elevenlabs.scribe",
    task: "batchAsr",
    kind: "api",
    provider: "elevenlabs",
    label: "ElevenLabs Scribe",
    langs: ["en", "fr"],
    implemented: true,
  },

  // TTS — chat / read-aloud / playground
  {
    id: "local.kokoro-en",
    task: "tts",
    kind: "local",
    modelTask: "tts",
    label: "Kokoro (local)",
    langs: ["en"],
    implemented: true,
  },
  {
    id: "elevenlabs.tts",
    task: "tts",
    kind: "api",
    provider: "elevenlabs",
    label: "ElevenLabs",
    langs: ["en", "fr"],
    implemented: true,
  },
  {
    id: "openai.tts",
    task: "tts",
    kind: "api",
    provider: "openai",
    label: "OpenAI TTS",
    langs: ["en", "fr"],
    implemented: true,
  },

  // Cloned-voice TTS
  {
    // zh/en only — no French (spec §7.1); FR clones are ElevenLabs-only.
    id: "local.zipvoice",
    task: "cloneTts",
    kind: "local",
    modelTask: "clone-tts",
    label: "ZipVoice (local)",
    langs: ["en", "zh"],
    implemented: true,
    params: [
      {
        key: "speed",
        label: "Speed",
        type: "number",
        min: 0.5,
        max: 2,
        step: 0.1,
        default: 1,
        unit: "×",
      },
      {
        // Flow-matching sampling steps: more = better quality, linearly
        // slower. 4 is the spike's A/B pick (spike-zipvoice.md).
        key: "numSteps",
        label: "Sampling steps",
        type: "number",
        min: 2,
        max: 16,
        step: 1,
        default: 4,
      },
    ],
  },
  {
    id: "elevenlabs.clone",
    task: "cloneTts",
    kind: "api",
    provider: "elevenlabs",
    label: "ElevenLabs clone",
    langs: ["en", "fr"],
    implemented: true,
  },

  // Diarization
  {
    id: "local.pyannote",
    task: "diarization",
    kind: "local",
    modelTask: "diarization",
    label: "Pyannote (local)",
    langs: ["en", "fr"],
    implemented: true,
    params: [
      {
        key: "numSpeakers",
        label: "Speakers (0 = auto)",
        type: "number",
        min: 0,
        max: 8,
        step: 1,
        default: 0,
      },
      {
        key: "threshold",
        label: "Cluster threshold",
        type: "number",
        min: 0.1,
        max: 0.9,
        step: 0.05,
        default: 0.5,
      },
    ],
  },
  {
    id: "deepgram.diarize",
    task: "diarization",
    kind: "api",
    provider: "deepgram",
    label: "Deepgram diarization",
    langs: ["en", "fr"],
    implemented: true,
  },

  // Local-only tasks (spec §3.4: no API alternatives in v1)
  {
    id: "local.silero-vad",
    task: "vad",
    kind: "local",
    modelTask: "vad",
    label: "Silero VAD (local)",
    langs: ["en", "fr"],
    implemented: true,
    params: [
      {
        key: "threshold",
        label: "Speech threshold",
        type: "number",
        min: 0.05,
        max: 0.95,
        step: 0.05,
        default: 0.5,
      },
      {
        key: "minSilence",
        label: "Min silence",
        type: "number",
        min: 0.1,
        max: 2,
        step: 0.1,
        default: 0.5,
        unit: "s",
      },
      {
        key: "minSpeech",
        label: "Min speech",
        type: "number",
        min: 0.05,
        max: 1,
        step: 0.05,
        default: 0.25,
        unit: "s",
      },
    ],
  },
  {
    id: "local.speaker-embedding",
    task: "speakerId",
    kind: "local",
    modelTask: "speaker-embedding",
    label: "3D-Speaker embedding (local)",
    langs: ["en", "fr"],
    implemented: true,
    params: [
      {
        key: "threshold",
        label: "Match threshold",
        type: "number",
        min: 0.05,
        max: 0.95,
        step: 0.05,
        default: 0.5,
      },
    ],
  },
  {
    id: "local.speaker-embedding",
    task: "speakerVerify",
    kind: "local",
    modelTask: "speaker-embedding",
    label: "3D-Speaker embedding (local)",
    langs: ["en", "fr"],
    implemented: true,
    params: [
      {
        key: "threshold",
        label: "Match threshold",
        type: "number",
        min: 0.05,
        max: 0.95,
        step: 0.05,
        default: 0.5,
      },
    ],
  },
  {
    id: "local.ct-transformer",
    task: "punctuation",
    kind: "local",
    modelTask: "punctuation",
    label: "CT-Transformer (local)",
    langs: ["en"],
    implemented: true,
  },
  {
    id: "local.kws-zipformer",
    task: "kws",
    kind: "local",
    modelTask: "kws",
    label: "Zipformer KWS (local)",
    langs: ["en"],
    implemented: true,
    params: [
      {
        key: "keywordsScore",
        label: "Keyword boost",
        type: "number",
        min: 0.5,
        max: 3,
        step: 0.1,
        default: 1,
        unit: "×",
      },
    ],
  },
  {
    id: "local.spleeter",
    task: "separation",
    kind: "local",
    modelTask: "separation",
    label: "Spleeter 2-stem (local)",
    langs: [],
    implemented: true,
  },
  {
    id: "local.whisper-langid",
    task: "langId",
    kind: "local",
    modelTask: "lang-id",
    label: "Whisper language ID (local)",
    langs: [],
    implemented: true,
  },
];

export function enginesForTask(task: SpeechTask): EngineDescriptor[] {
  return ENGINE_DESCRIPTORS.filter((engine) => engine.task === task);
}

export function findEngine(task: SpeechTask, id: string): EngineDescriptor | undefined {
  return ENGINE_DESCRIPTORS.find((engine) => engine.task === task && engine.id === id);
}
