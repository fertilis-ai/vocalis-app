import { create } from "zustand";
import {
  type TtsVoice,
  ttsVoicesFileSchema,
} from "@/lib/schemas/voices";
import { readFile, writeFile } from "@/lib/storage";

// Owns ~/.vocalis/voices/tts-voices.json (spec §3.5 TtsVoice, M5 item 4):
// per-voice favorites and default speed for every kind of voice, plus the
// persisted clone-voice entries derived from People profiles. Enumeration
// for pickers stays in lib/engines/tts-voices.ts — this store only holds the
// durable state that enumeration merges in by voice id.

const VOICES_FILE = "~/.vocalis/voices/tts-voices.json";

/** The Voices section's two tabs (spec §2.4): People and the voice library. */
export type VoicesView = "people" | "library";

interface VoicesState {
  /** voice id (picker key) → library entry */
  voices: Record<string, TtsVoice>;
  loaded: boolean;
  /** Active Voices-section tab (session-only, not persisted). */
  view: VoicesView;

  setView: (view: VoicesView) => void;
  load: () => Promise<void>;
  /** Flip a voice's favorite star, seeding its entry on first touch. */
  toggleFavorite: (seed: TtsVoice) => Promise<void>;
  /** Set (or clear) a voice's default speed, seeding its entry on first touch. */
  setDefaultSpeed: (seed: TtsVoice, speed: number | undefined) => Promise<void>;
  /** Reconcile kind:"clone" entries against the People list: upsert one entry
   * per existing clone, drop entries whose person or clone is gone. Favorites
   * on surviving clones are preserved. */
  syncClones: (clones: TtsVoice[]) => Promise<void>;
}

async function persist(voices: Record<string, TtsVoice>): Promise<void> {
  const file = { voices: Object.values(voices) };
  await writeFile(VOICES_FILE, JSON.stringify(file, null, 2));
}

export const useVoicesStore = create<VoicesState>()((set, get) => ({
  voices: {},
  loaded: false,
  view: "people",

  setView: (view) => set({ view }),

  load: async () => {
    if (get().loaded) return;
    set({ loaded: true });
    try {
      const raw = await readFile(VOICES_FILE);
      if (!raw) return;
      const file = ttsVoicesFileSchema.parse(JSON.parse(raw));
      const voices: Record<string, TtsVoice> = {};
      for (const voice of file.voices) voices[voice.id] = voice;
      set({ voices });
    } catch (err) {
      // A malformed library must not take voice pickers down — start empty.
      console.warn("[voices] unreadable tts-voices.json:", err);
    }
  },

  toggleFavorite: async (seed) => {
    const current = get().voices[seed.id] ?? seed;
    const voices = {
      ...get().voices,
      [seed.id]: { ...current, favorite: !current.favorite },
    };
    set({ voices });
    await persist(voices);
  },

  setDefaultSpeed: async (seed, speed) => {
    const current = get().voices[seed.id] ?? seed;
    const voices = {
      ...get().voices,
      [seed.id]: { ...current, params: { ...current.params, speed } },
    };
    set({ voices });
    await persist(voices);
  },

  syncClones: async (clones) => {
    const existing = get().voices;
    const next: Record<string, TtsVoice> = {};
    // Keep every non-clone entry untouched.
    for (const voice of Object.values(existing)) {
      if (voice.kind !== "clone") next[voice.id] = voice;
    }
    for (const clone of clones) {
      const prior = existing[clone.id];
      next[clone.id] = prior
        ? { ...clone, favorite: prior.favorite, params: prior.params }
        : clone;
    }
    // Only write when something actually changed — syncClones runs on every
    // People load.
    const changed =
      JSON.stringify(Object.values(next).map((v) => v.id).sort()) !==
        JSON.stringify(Object.values(existing).map((v) => v.id).sort()) ||
      clones.some((c) => {
        const prior = existing[c.id];
        return prior && (prior.label !== c.label || prior.engineId !== c.engineId);
      });
    set({ voices: next });
    if (changed) await persist(next);
  },
}));
