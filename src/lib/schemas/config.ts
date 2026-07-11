import { z } from "zod";
import { HUE_PRESETS, type HueId } from "@/lib/hue-presets";

// Schema for ~/.vocalis/config.yaml (spec §4). The file is human-editable,
// so every field is defaulted AND caught: a partial or hand-mangled file
// degrades to defaults per-field instead of crashing the app.

export const ROUTING_TASKS = [
  "streamingAsr",
  "batchAsr",
  "tts",
  "cloneTts",
  "diarization",
] as const;

export type RoutingTask = (typeof ROUTING_TASKS)[number];

/** v1 default engine per task — spec §3.4 */
export const DEFAULT_ROUTING: Record<RoutingTask, string> = {
  streamingAsr: "local.zipformer-en",
  batchAsr: "local.whisper-small",
  tts: "local.kokoro-en",
  cloneTts: "local.zipvoice",
  diarization: "local.pyannote",
};

export const DEFAULT_DICTATION = {
  hotkey: "Alt+Space",
  mode: "hold",
  polish: false,
  polishModel: "",
  historyEnabled: true,
} as const;

export const DEFAULT_TTS_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/** "" = system default input device */
export const DEFAULT_AUDIO = { inputDevice: "" } as const;

/** "" model = auto-detect the server's first available model at stream time */
export const DEFAULT_LOCAL_LLM = {
  provider: "ollama",
  baseUrl: "http://localhost:11434",
  model: "",
} as const;

const hueIds = HUE_PRESETS.map((p) => p.id) as [HueId, ...HueId[]];

const themeSchema = z.enum(["system", "light", "dark"]).default("dark").catch("dark");
const hueSchema = z.enum(hueIds).default("neutral").catch("neutral");

const appearanceSchema = z
  .object({
    theme: themeSchema,
    hue: hueSchema,
  })
  .default({ theme: "dark", hue: "neutral" })
  .catch({ theme: "dark", hue: "neutral" });

const routingSchema = z
  .object({
    streamingAsr: z.string().default(DEFAULT_ROUTING.streamingAsr).catch(DEFAULT_ROUTING.streamingAsr),
    batchAsr: z.string().default(DEFAULT_ROUTING.batchAsr).catch(DEFAULT_ROUTING.batchAsr),
    tts: z.string().default(DEFAULT_ROUTING.tts).catch(DEFAULT_ROUTING.tts),
    cloneTts: z.string().default(DEFAULT_ROUTING.cloneTts).catch(DEFAULT_ROUTING.cloneTts),
    diarization: z.string().default(DEFAULT_ROUTING.diarization).catch(DEFAULT_ROUTING.diarization),
  })
  .default(DEFAULT_ROUTING)
  .catch(DEFAULT_ROUTING);

const dictationSchema = z
  .object({
    hotkey: z.string().default(DEFAULT_DICTATION.hotkey).catch(DEFAULT_DICTATION.hotkey),
    mode: z.enum(["hold", "toggle"]).default(DEFAULT_DICTATION.mode).catch(DEFAULT_DICTATION.mode),
    polish: z.boolean().default(DEFAULT_DICTATION.polish).catch(DEFAULT_DICTATION.polish),
    polishModel: z.string().default(DEFAULT_DICTATION.polishModel).catch(DEFAULT_DICTATION.polishModel),
    historyEnabled: z
      .boolean()
      .default(DEFAULT_DICTATION.historyEnabled)
      .catch(DEFAULT_DICTATION.historyEnabled),
  })
  .default(DEFAULT_DICTATION)
  .catch(DEFAULT_DICTATION);

const modelsSchema = z
  .object({
    /** task -> installed modelId serving that task (Models section slots) */
    activeByTask: z.record(z.string(), z.string()).default({}).catch({}),
  })
  .default({ activeByTask: {} })
  .catch({ activeByTask: {} });

const audioSchema = z
  .object({
    inputDevice: z.string().default(DEFAULT_AUDIO.inputDevice).catch(DEFAULT_AUDIO.inputDevice),
  })
  .default(DEFAULT_AUDIO)
  .catch(DEFAULT_AUDIO);

const cacheSchema = z
  .object({
    ttsMaxBytes: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_TTS_CACHE_MAX_BYTES)
      .catch(DEFAULT_TTS_CACHE_MAX_BYTES),
  })
  .default({ ttsMaxBytes: DEFAULT_TTS_CACHE_MAX_BYTES })
  .catch({ ttsMaxBytes: DEFAULT_TTS_CACHE_MAX_BYTES });

const localLlmSchema = z
  .object({
    provider: z.enum(["ollama", "lmstudio"]).default(DEFAULT_LOCAL_LLM.provider).catch(DEFAULT_LOCAL_LLM.provider),
    baseUrl: z.string().default(DEFAULT_LOCAL_LLM.baseUrl).catch(DEFAULT_LOCAL_LLM.baseUrl),
    model: z.string().default(DEFAULT_LOCAL_LLM.model).catch(DEFAULT_LOCAL_LLM.model),
  })
  .default(DEFAULT_LOCAL_LLM)
  .catch(DEFAULT_LOCAL_LLM);

export const configSchema = z.object({
  appearance: appearanceSchema,
  privacyMode: z.boolean().default(false).catch(false),
  routing: routingSchema,
  dictation: dictationSchema,
  models: modelsSchema,
  audio: audioSchema,
  cache: cacheSchema,
  localLlm: localLlmSchema,
});

export type ConfigYaml = z.infer<typeof configSchema>;

/** Full-default config (what a fresh install writes) */
export function defaultConfig(): ConfigYaml {
  return configSchema.parse({});
}

/**
 * Parse an untrusted config value (YAML.parse output). Never throws:
 * unknown/broken fields fall back to their defaults, and a completely
 * unusable value yields the full default config.
 */
export function parseConfig(value: unknown): ConfigYaml {
  const result = configSchema.safeParse(value ?? {});
  return result.success ? result.data : defaultConfig();
}
