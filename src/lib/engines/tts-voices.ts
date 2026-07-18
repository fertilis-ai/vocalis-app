import { type EngineDescriptor, findEngine } from "@/lib/engines/descriptors";
import { ELEVENLABS_DEFAULT_VOICE } from "@/lib/engines/elevenlabs";
import type { SynthTarget } from "@/lib/engines/port";
import type { InstalledModel } from "@/lib/schemas/catalog";
import type { Person } from "@/lib/schemas/people";
import type { TtsVoice } from "@/lib/schemas/voices";
import { personDir } from "@/stores/people-store";

// Voice enumeration for every picker in the app (spec §2.4, M5 item 4):
// stock local voices from installed models, provider voices when a key is
// present, and clone voices derived from People — merged with the voice
// library's durable state (favorites, default speed) by voice id.

/** A stock local voice. sherpa's TTS API keys a voice by integer speaker id
 * (`sid`); the human names below are documented per model — sherpa can report
 * a speaker count but not voice names. Models not listed in the table fall
 * back to a single "Default voice" (sid 0). */
export interface StockVoice {
  /** Installed model id (the `models/tts/<id>` dir name). */
  modelId: string;
  /** sherpa speaker id passed to tts_synthesize. */
  sid: number;
  /** Human-facing voice name. */
  label: string;
  /** BCP-47-ish language tag for the voice. */
  lang: string;
}

type VoiceSpec = Omit<StockVoice, "modelId">;

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
export function voicesForModel(modelId: string): StockVoice[] {
  const specs = VOICE_TABLE[modelId] ?? [
    { sid: 0, label: "Default voice", lang: "" },
  ];
  return specs.map((spec) => ({ modelId, ...spec }));
}

/** One display group per installed TTS model, with its voices. */
export interface VoiceGroup {
  modelId: string;
  voices: StockVoice[];
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

/** A voice as shown in the picker. `kind` drives the badge: stock local,
 * provider cloud, or a clone derived from a Person. */
export interface PickerVoice {
  kind: "local" | "api" | "clone";
  /** Stable key — doubles as the voice library id. */
  key: string;
  label: string;
  lang: string;
  target: SynthTarget;
  /** Source person for clone voices (badge + library bookkeeping). */
  personId?: string;
  favorite: boolean;
  /** Per-voice default speed from the library. */
  defaultSpeed?: number;
}

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
  switch (target.kind) {
    case "local":
      return findEngine("tts", "local.kokoro-en");
    case "api":
      return findEngine("tts", `${target.provider}.tts`);
    case "clone-local":
      return findEngine("cloneTts", "local.zipvoice");
    case "clone-api":
      return findEngine("cloneTts", "elevenlabs.clone");
  }
}

/** The fixed preview sentence pickers speak, per voice language (spec §2.4). */
export function previewSentence(lang: string): string {
  return lang.toLowerCase().startsWith("fr")
    ? "Bonjour ! Voici un aperçu de cette voix dans Vocalis."
    : "Hi there! This is a preview of this voice in Vocalis.";
}

/** The stored form of a picked voice (`conversation.voiceId`): local sid as a
 * string, API voice id as-is, clone voices their full key (the "clone:"
 * prefix is what read-aloud routing dispatches on). */
export function voiceStorageId(voice: PickerVoice): string {
  switch (voice.target.kind) {
    case "local":
      return String(voice.target.sid);
    case "api":
      return voice.target.voice;
    default:
      return voice.key;
  }
}

/** Library seed for a picker voice — used to upsert favorites/speed for
 * voices that have no tts-voices.json entry yet. */
export function toLibraryVoice(voice: PickerVoice): TtsVoice {
  const engine = engineForTarget(voice.target);
  return {
    id: voice.key,
    label: voice.label,
    engineId: engine?.id ?? "unknown",
    kind: voice.kind === "local" ? "stock" : voice.kind === "api" ? "provider" : "clone",
    personId: voice.personId,
    langs: voice.lang ? [voice.lang] : [],
    params: voice.defaultSpeed !== undefined ? { speed: voice.defaultSpeed } : {},
    favorite: voice.favorite,
  };
}

/** Library entries for every clone a person carries — what
 * `voices-store.syncClones` persists. ZipVoice clones are en/zh only
 * (no French, spec §7.1); ElevenLabs clones are multilingual. */
export function cloneLibraryVoices(people: Person[]): TtsVoice[] {
  const entries: TtsVoice[] = [];
  for (const person of people) {
    if (person.clones.zipvoice) {
      entries.push({
        id: `clone:zipvoice:${person.id}`,
        label: `${person.name} — clone (local)`,
        engineId: "local.zipvoice",
        kind: "clone",
        personId: person.id,
        langs: ["en", "zh"],
        params: {},
        favorite: false,
      });
    }
    if (person.clones.elevenlabs) {
      entries.push({
        id: `clone:elevenlabs:${person.id}`,
        label: `${person.name} — clone (ElevenLabs)`,
        engineId: "elevenlabs.clone",
        kind: "clone",
        personId: person.id,
        langs: ["en", "fr"],
        params: {},
        favorite: false,
      });
    }
  }
  return entries;
}

export interface VoiceCatalogExtras {
  /** People with clones — feeds the clone voice group. */
  people?: Person[];
  /** Voice library state (favorites, default speed) keyed by voice id. */
  library?: Record<string, TtsVoice>;
}

/**
 * Every voice the app can drive right now: installed local models, clone
 * voices from People, and — when privacy mode is off and a key is present —
 * each cloud provider's voices. API groups (including ElevenLabs clones) are
 * omitted under privacy mode: the router blocks API engines and pickers must
 * not offer them (spec §3.4). Favorites float to the top of each group.
 */
export function buildVoiceGroups(
  installed: InstalledModel[],
  apiKeys: Record<string, string>,
  privacyMode: boolean,
  extras: VoiceCatalogExtras = {},
): PickerGroup[] {
  const library = extras.library ?? {};
  const decorate = (voice: Omit<PickerVoice, "favorite">): PickerVoice => {
    const entry = library[voice.key];
    return {
      ...voice,
      favorite: entry?.favorite ?? false,
      defaultSpeed: entry?.params.speed,
    };
  };

  const groups: PickerGroup[] = installedVoiceGroups(installed).map((group) => ({
    id: `local:${group.modelId}`,
    label: group.modelId,
    voices: group.voices.map((v) =>
      decorate({
        kind: "local" as const,
        key: `local:${v.modelId}:${v.sid}`,
        label: v.label,
        lang: v.lang,
        target: { kind: "local" as const, modelId: v.modelId, sid: v.sid },
      }),
    ),
  }));

  // Clone voices (M5): local ZipVoice clones need the clone-tts model
  // installed; ElevenLabs clones need a key and are API — privacy-filtered
  // with the rest of the cloud voices below.
  const people = extras.people ?? [];
  const cloneTtsInstalled = installed.some((m) => m.task === "clone-tts");
  const cloneVoices: PickerVoice[] = [];
  for (const person of people) {
    if (person.clones.zipvoice && cloneTtsInstalled) {
      cloneVoices.push(
        decorate({
          kind: "clone" as const,
          key: `clone:zipvoice:${person.id}`,
          label: `${person.name} — clone (local)`,
          lang: "en",
          personId: person.id,
          target: {
            kind: "clone-local" as const,
            refAudio: `${personDir(person.id)}/${person.clones.zipvoice.refAudio}`,
            refText: person.clones.zipvoice.refText,
          },
        }),
      );
    }
    if (person.clones.elevenlabs && !privacyMode && apiKeys.elevenlabs) {
      cloneVoices.push(
        decorate({
          kind: "clone" as const,
          key: `clone:elevenlabs:${person.id}`,
          label: `${person.name} — clone (ElevenLabs)`,
          lang: "en",
          personId: person.id,
          target: {
            kind: "clone-api" as const,
            provider: "elevenlabs" as const,
            voiceId: person.clones.elevenlabs.voiceId,
          },
        }),
      );
    }
  }
  if (cloneVoices.length > 0) {
    groups.push({ id: "clones", label: "Cloned voices", voices: cloneVoices });
  }

  if (!privacyMode) {
    if (apiKeys.openai) {
      groups.push({
        id: "api:openai",
        label: "OpenAI (cloud)",
        voices: OPENAI_VOICES.map((voice) =>
          decorate({
            kind: "api" as const,
            key: `api:openai:${voice}`,
            label: `${voice} (OpenAI)`,
            lang: "en",
            target: { kind: "api" as const, provider: "openai", voice },
          }),
        ),
      });
    }
    if (apiKeys.elevenlabs) {
      groups.push({
        id: "api:elevenlabs",
        label: "ElevenLabs (cloud)",
        voices: ELEVENLABS_VOICES.map((v) =>
          decorate({
            kind: "api" as const,
            key: `api:elevenlabs:${v.id}`,
            label: `${v.label} (ElevenLabs)`,
            lang: "en",
            target: { kind: "api" as const, provider: "elevenlabs", voice: v.id },
          }),
        ),
      });
    }
  }

  // Favorites float to the top of their group (spec §2.4), stable otherwise.
  for (const group of groups) {
    group.voices.sort((a, b) => Number(b.favorite) - Number(a.favorite));
  }
  return groups;
}
