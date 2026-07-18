import { z } from "zod";

// The TTS voice library (spec §3.5 `TtsVoice`, M5 item 4), persisted at
// ~/.vocalis/voices/tts-voices.json. The file stores durable per-voice user
// state — favorites, default speed — plus the clone-voice entries derived
// from People. Availability (model installed, key present, privacy mode) is
// still decided at enumeration time in `lib/engines/tts-voices.ts`; an entry
// here whose engine is unavailable simply doesn't show in pickers.

export const ttsVoiceSchema = z.object({
  /** Stable picker key, e.g. "local:kokoro-en-v0_19:3", "api:openai:alloy",
   * "clone:zipvoice:<personId>". */
  id: z.string().min(1),
  label: z.string().min(1),
  /** EngineDescriptor id that speaks this voice (e.g. "local.zipvoice"). */
  engineId: z.string().min(1),
  kind: z.enum(["stock", "provider", "clone"]),
  /** Source person for clone voices. */
  personId: z.string().optional(),
  langs: z.array(z.string()).default([]),
  params: z
    .object({ speed: z.number().min(0.5).max(2).optional() })
    .default({}),
  favorite: z.boolean().default(false),
});

export type TtsVoice = z.infer<typeof ttsVoiceSchema>;

export const ttsVoicesFileSchema = z.object({
  voices: z.array(ttsVoiceSchema).default([]),
});

export type TtsVoicesFile = z.infer<typeof ttsVoicesFileSchema>;
