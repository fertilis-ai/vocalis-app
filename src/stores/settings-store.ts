import { isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { HueId } from "@/lib/hue-presets";
import { deleteApiKey, loadAllApiKeys, storeApiKey } from "@/lib/keychain";
import type { LocalLlmSettings } from "@/lib/llm/stream-chat";
import {
  DEFAULT_AUDIO,
  DEFAULT_DICTATION,
  DEFAULT_LOCAL_LLM,
  DEFAULT_ROUTING,
  DEFAULT_TTS_CACHE_MAX_BYTES,
} from "@/lib/schemas/config";

export type DictationMode = "hold" | "toggle";

export interface DictationPrefs {
  hotkey: string;
  mode: DictationMode;
  polish: boolean;
  polishModel: string;
  historyEnabled: boolean;
}

// Persisted via localStorage ("vocalis-settings") AND two-way synced with
// ~/.vocalis/config.yaml on desktop (lib/config-sync.ts). API keys are the
// exception: on desktop they live only in the macOS keychain (write-through
// in setApiKey, excluded from localStorage by partialize).
interface SettingsState {
  hue: HueId;
  privacyMode: boolean;
  /** task -> active engineId (spec §3.4 routing matrix) */
  routing: Record<string, string>;
  dictation: DictationPrefs;
  /** task -> installed local modelId serving that task (spec §2.5 slots) */
  activeByTask: Record<string, string>;
  /** preferred capture device name; "" = system default */
  audioInputDevice: string;
  ttsCacheMaxBytes: number;
  /** provider -> API key (keychain-backed on desktop) */
  apiKeys: Record<string, string>;
  localLLM: LocalLlmSettings;

  setHue: (hue: HueId) => void;
  setPrivacyMode: (on: boolean) => void;
  setRouting: (routing: Record<string, string>) => void;
  setTaskEngine: (task: string, engineId: string) => void;
  setDictation: (updates: Partial<DictationPrefs>) => void;
  setActiveByTask: (activeByTask: Record<string, string>) => void;
  setActiveModel: (task: string, modelId: string) => void;
  /** Clear the slot only if it still points at modelId (e.g. after delete) */
  clearActiveModel: (task: string, modelId: string) => void;
  setAudioInputDevice: (device: string) => void;
  setTtsCacheMaxBytes: (bytes: number) => void;
  setApiKey: (provider: string, key: string) => void;
  loadApiKeysFromKeychain: () => Promise<void>;
  setLocalLLM: (updates: Partial<LocalLlmSettings>) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      hue: "neutral",
      privacyMode: false,
      routing: { ...DEFAULT_ROUTING },
      dictation: { ...DEFAULT_DICTATION },
      activeByTask: {},
      audioInputDevice: DEFAULT_AUDIO.inputDevice,
      ttsCacheMaxBytes: DEFAULT_TTS_CACHE_MAX_BYTES,
      apiKeys: {},
      localLLM: { ...DEFAULT_LOCAL_LLM },

      setHue: (hue) => set({ hue }),
      setPrivacyMode: (privacyMode) => set({ privacyMode }),
      setRouting: (routing) => set({ routing }),
      setTaskEngine: (task, engineId) =>
        set((state) => ({ routing: { ...state.routing, [task]: engineId } })),
      setDictation: (updates) =>
        set((state) => ({ dictation: { ...state.dictation, ...updates } })),
      setActiveByTask: (activeByTask) => set({ activeByTask }),
      setActiveModel: (task, modelId) =>
        set((state) => ({ activeByTask: { ...state.activeByTask, [task]: modelId } })),
      clearActiveModel: (task, modelId) =>
        set((state) => {
          if (state.activeByTask[task] !== modelId) return state;
          const { [task]: _cleared, ...activeByTask } = state.activeByTask;
          return { activeByTask };
        }),
      setAudioInputDevice: (audioInputDevice) => set({ audioInputDevice }),
      setTtsCacheMaxBytes: (ttsCacheMaxBytes) => set({ ttsCacheMaxBytes }),
      setApiKey: (provider, key) => {
        set((state) => ({
          apiKeys: { ...state.apiKeys, [provider]: key },
        }));
        const writeThrough = key ? storeApiKey(provider, key) : deleteApiKey(provider);
        writeThrough.catch((err) => {
          console.warn("[settings] Failed to update key in keychain:", err);
        });
      },
      setLocalLLM: (updates) =>
        set((state) => ({ localLLM: { ...state.localLLM, ...updates } })),
      loadApiKeysFromKeychain: async () => {
        try {
          const keys = await loadAllApiKeys();
          if (Object.keys(keys).length === 0) return;
          set((state) => ({
            apiKeys: {
              ...state.apiKeys,
              ...Object.fromEntries(Object.entries(keys).filter(([, v]) => v)),
            },
          }));
        } catch (err) {
          console.warn("[settings] Failed to load API keys from keychain:", err);
        }
      },
    }),
    {
      name: "vocalis-settings",
      partialize: (state) => ({
        hue: state.hue,
        privacyMode: state.privacyMode,
        routing: state.routing,
        dictation: state.dictation,
        activeByTask: state.activeByTask,
        audioInputDevice: state.audioInputDevice,
        ttsCacheMaxBytes: state.ttsCacheMaxBytes,
        localLLM: state.localLLM,
        // On desktop, apiKeys live in the OS keychain — never localStorage
        ...(isTauri() ? {} : { apiKeys: state.apiKeys }),
      }),
    },
  ),
);
