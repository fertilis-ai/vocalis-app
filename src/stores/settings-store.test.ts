import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DICTATION, DEFAULT_ROUTING } from "@/lib/schemas/config";

// Mock zustand persist to be a passthrough (avoids localStorage issues in tests)
vi.mock("zustand/middleware", () => ({
  persist: (fn: unknown) => fn,
}));

vi.mock("@tauri-apps/api/core", () => import("@/test/mocks/tauri"));

const mockStoreApiKey = vi.fn();
const mockDeleteApiKey = vi.fn();
const mockLoadAllApiKeys = vi.fn();

vi.mock("@/lib/keychain", () => ({
  storeApiKey: (...args: unknown[]) => mockStoreApiKey(...args),
  deleteApiKey: (...args: unknown[]) => mockDeleteApiKey(...args),
  loadAllApiKeys: (...args: unknown[]) => mockLoadAllApiKeys(...args),
}));

import { useSettingsStore } from "./settings-store";

describe("settings-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreApiKey.mockResolvedValue(undefined);
    mockDeleteApiKey.mockResolvedValue(undefined);
    mockLoadAllApiKeys.mockResolvedValue({});
    useSettingsStore.setState({
      hue: "neutral",
      privacyMode: false,
      routing: { ...DEFAULT_ROUTING },
      dictation: { ...DEFAULT_DICTATION },
      activeByTask: {},
      apiKeys: {},
    });
  });

  it("has spec §3.4 routing defaults", () => {
    expect(useSettingsStore.getState().routing).toEqual({
      streamingAsr: "local.zipformer-en",
      batchAsr: "local.whisper-small",
      tts: "local.kokoro-en",
      cloneTts: "local.zipvoice",
      diarization: "local.pyannote",
    });
  });

  it("setTaskEngine updates only the given task", () => {
    useSettingsStore.getState().setTaskEngine("tts", "elevenlabs");
    const { routing } = useSettingsStore.getState();
    expect(routing.tts).toBe("elevenlabs");
    expect(routing.streamingAsr).toBe(DEFAULT_ROUTING.streamingAsr);
  });

  it("setDictation merges partial updates", () => {
    useSettingsStore.getState().setDictation({ mode: "toggle" });
    expect(useSettingsStore.getState().dictation).toEqual({
      ...DEFAULT_DICTATION,
      mode: "toggle",
    });
  });

  it("setActiveModel updates only the given task slot", () => {
    useSettingsStore.getState().setActiveModel("streamingAsr", "zipformer-streaming-en");
    useSettingsStore.getState().setActiveModel("tts", "kokoro-en");
    expect(useSettingsStore.getState().activeByTask).toEqual({
      streamingAsr: "zipformer-streaming-en",
      tts: "kokoro-en",
    });
  });

  it("clearActiveModel clears the slot only when it still points at the model", () => {
    useSettingsStore.getState().setActiveModel("tts", "kokoro-en");
    useSettingsStore.getState().clearActiveModel("tts", "some-other-model");
    expect(useSettingsStore.getState().activeByTask.tts).toBe("kokoro-en");
    useSettingsStore.getState().clearActiveModel("tts", "kokoro-en");
    expect(useSettingsStore.getState().activeByTask.tts).toBeUndefined();
  });

  it("setApiKey stores the key and writes through to the keychain", () => {
    useSettingsStore.getState().setApiKey("openai", "sk-123");
    expect(useSettingsStore.getState().apiKeys.openai).toBe("sk-123");
    expect(mockStoreApiKey).toHaveBeenCalledWith("openai", "sk-123");
    expect(mockDeleteApiKey).not.toHaveBeenCalled();
  });

  it("setApiKey with an empty key deletes it from the keychain", () => {
    useSettingsStore.getState().setApiKey("openai", "");
    expect(mockDeleteApiKey).toHaveBeenCalledWith("openai");
    expect(mockStoreApiKey).not.toHaveBeenCalled();
  });

  it("loadApiKeysFromKeychain merges non-empty keys into the store", async () => {
    mockLoadAllApiKeys.mockResolvedValue({ deepgram: "dg-1", groq: "" });
    useSettingsStore.setState({ apiKeys: { openai: "sk-existing" } });

    await useSettingsStore.getState().loadApiKeysFromKeychain();

    expect(useSettingsStore.getState().apiKeys).toEqual({
      openai: "sk-existing",
      deepgram: "dg-1",
    });
  });

  it("loadApiKeysFromKeychain tolerates keychain errors", async () => {
    mockLoadAllApiKeys.mockRejectedValue(new Error("keychain locked"));
    await useSettingsStore.getState().loadApiKeysFromKeychain();
    expect(useSettingsStore.getState().apiKeys).toEqual({});
  });
});
