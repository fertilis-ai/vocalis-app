import { type EngineDescriptor, findEngine } from "@/lib/engines/descriptors";
import { ELEVENLABS_DEFAULT_VOICE } from "@/lib/engines/elevenlabs";
import type { SynthTarget } from "@/lib/engines/port";
import type { InstalledModel } from "@/lib/schemas/catalog";

// Stock-voice catalog for local TTS (spec M2 item 8). sherpa's TTS API keys a
// voice by integer speaker id (`sid`); the human names below are documented
// per model — sherpa can report a speaker count but not voice names. Models
// not listed here fall back to a single "Default voice" (sid 0); multi-voice
// custom models are an item-10 concern.

export interface TtsVoice {
  /** Installed model id (the `models/tts/<id>` dir name). */
  modelId: string;
  /** sherpa speaker id passed to tts_synthesize. */
  sid: number;
  /** Human-facing voice name. */
  label: string;
  /** BCP-47-ish language tag for the voice. */
  lang: string;
}

type VoiceSpec = Omit<TtsVoice, "modelId">;

// Kokoro EN v0.19 ships 11 voices in this fixed sid order (a = American,
// b = British; f = female, m = male). Names match the k2-fsa release notes.
const KOKORO_EN_V0_19: VoiceSpec[] = [
  { sid: 0, label: "Default (blend)", lang: "en-US" },
  { sid: 1, label: "Bella (US, female)", lang: "en-US" },
  { sid: 2, label: "Nicole (US, female)", lang: "en-US" },
  { sid: 3, label: "Sarah (US, female)", lang: "en-US" },
  { sid: 4, label: "Sky (US, female)", lang: "en-US" },
  { sid: 5, label: "Adam (US, male)", lang: "en-US" },
  { sid: 6, label: "Michael (US, male)", lang: "en-US" },
  { sid: 7, label: "Emma (UK, female)", lang: "en-GB" },
  { sid: 8, label: "Isabella (UK, female)", lang: "en-GB" },
  { sid: 9, label: "George (UK, male)", lang: "en-GB" },
  { sid: 10, label: "Lewis (UK, male)", lang: "en-GB" },
];

/** Voice tables keyed by installed model id (== catalog id for stock models). */
const VOICE_TABLE: Record<string, VoiceSpec[]> = {
  "kokoro-en-v0_19": KOKORO_EN_V0_19,
  "piper-fr-siwis": [{ sid: 0, label: "SIWIS (French)", lang: "fr-FR" }],
};

/** Voices for one installed TTS model. Unknown models get one default voice. */
export function voicesForModel(modelId: string): TtsVoice[] {
  const specs = VOICE_TABLE[modelId] ?? [
    { sid: 0, label: "Default voice", lang: "" },
  ];
  return specs.map((spec) => ({ modelId, ...spec }));
}

/** One display group per installed TTS model, with its voices. */
export interface VoiceGroup {
  modelId: string;
  voices: TtsVoice[];
}

/** Flatten installed TTS models into voice groups for the picker. */
export function installedVoiceGroups(installed: InstalledModel[]): VoiceGroup[] {
  return installed
    .filter((model) => model.task === "tts")
    .map((model) => ({
      modelId: model.id,
      voices: voicesForModel(model.id),
    }));
}

// ── Cloud voices (M2 item 9) ────────────────────────────────────────────────

/** OpenAI's six built-in speech voices. */
const OPENAI_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

/** A couple of ElevenLabs stock voice ids for the bench (users can extend). */
const ELEVENLABS_VOICES: { id: string; label: string }[] = [
  { id: ELEVENLABS_DEFAULT_VOICE, label: "Rachel" },
  { id: "AZnzlk1XvdvUeBnXmlld", label: "Domi" },
];

/** A voice as shown in the picker — either a local model voice or a cloud voice. */
export type PickerVoice =
  | { kind: "local"; key: string; label: string; lang: string; target: SynthTarget }
  | { kind: "api"; key: string; label: string; lang: string; target: SynthTarget };

export interface PickerGroup {
  id: string;
  label: string;
  voices: PickerVoice[];
}

/**
 * The truthful EngineDescriptor for a synth target — what will actually run.
 * The TTS bench picks a voice directly rather than going through the task
 * engine router, so callers must derive the engine from the picked voice
 * instead of from `useEngineResolution("tts", ...)`, which reflects the
 * router's own pick and can disagree with the voice actually selected.
 */
export function engineForTarget(target: SynthTarget): EngineDescriptor | undefined {
  if (target.kind === "local") return findEngine("tts", "local.kokoro-en");
  return findEngine("tts", `${target.provider}.tts`);
}

/**
 * Every voice the TTS bench can drive right now: installed local models plus,
 * when privacy mode is off and a key is present, each cloud provider's voices.
 * API groups are omitted under privacy mode — the router blocks API engines and
 * the picker must not offer them (spec §3.4).
 */
export function buildVoiceGroups(
  installed: InstalledModel[],
  apiKeys: Record<string, string>,
  privacyMode: boolean,
): PickerGroup[] {
  const groups: PickerGroup[] = installedVoiceGroups(installed).map((group) => ({
    id: `local:${group.modelId}`,
    label: group.modelId,
    voices: group.voices.map((v) => ({
      kind: "local" as const,
      key: `local:${v.modelId}:${v.sid}`,
      label: v.label,
      lang: v.lang,
      target: { kind: "local" as const, modelId: v.modelId, sid: v.sid },
    })),
  }));

  if (privacyMode) return groups;

  if (apiKeys.openai) {
    groups.push({
      id: "api:openai",
      label: "OpenAI (cloud)",
      voices: OPENAI_VOICES.map((voice) => ({
        kind: "api" as const,
        key: `api:openai:${voice}`,
        label: `${voice} (OpenAI)`,
        lang: "en",
        target: { kind: "api" as const, provider: "openai", voice },
      })),
    });
  }
  if (apiKeys.elevenlabs) {
    groups.push({
      id: "api:elevenlabs",
      label: "ElevenLabs (cloud)",
      voices: ELEVENLABS_VOICES.map((v) => ({
        kind: "api" as const,
        key: `api:elevenlabs:${v.id}`,
        label: `${v.label} (ElevenLabs)`,
        lang: "en",
        target: { kind: "api" as const, provider: "elevenlabs", voice: v.id },
      })),
    });
  }
  return groups;
}
