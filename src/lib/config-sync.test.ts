import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import {
  DEFAULT_DICTATION,
  DEFAULT_LOCAL_LLM,
  DEFAULT_ROUTING,
  DEFAULT_TTS_CACHE_MAX_BYTES,
} from "@/lib/schemas/config";

// Mock storage
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockPathExists = vi.fn();
const mockGetAppDataDir = vi.fn();
const mockIsDesktop = vi.fn();

vi.mock("@/lib/storage", () => ({
  isDesktop: (...args: unknown[]) => mockIsDesktop(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  pathExists: (...args: unknown[]) => mockPathExists(...args),
  getAppDataDir: (...args: unknown[]) => mockGetAppDataDir(...args),
}));

// Build a mock settings store
const mockSetHue = vi.fn();
const mockSetPrivacyMode = vi.fn();
const mockSetRouting = vi.fn();
const mockSetDictation = vi.fn();
const mockSetActiveByTask = vi.fn();
const mockSetAudioInputDevice = vi.fn();
const mockSetTtsCacheMaxBytes = vi.fn();
const mockSetLocalLLM = vi.fn();
const mockLoadApiKeysFromKeychain = vi.fn();

const defaultStoreState = {
  hue: "neutral" as const,
  privacyMode: false,
  routing: { ...DEFAULT_ROUTING },
  dictation: { ...DEFAULT_DICTATION },
  activeByTask: {},
  audioInputDevice: "",
  ttsCacheMaxBytes: DEFAULT_TTS_CACHE_MAX_BYTES,
  localLLM: { ...DEFAULT_LOCAL_LLM },
  setHue: mockSetHue,
  setPrivacyMode: mockSetPrivacyMode,
  setRouting: mockSetRouting,
  setDictation: mockSetDictation,
  setActiveByTask: mockSetActiveByTask,
  setAudioInputDevice: mockSetAudioInputDevice,
  setTtsCacheMaxBytes: mockSetTtsCacheMaxBytes,
  setLocalLLM: mockSetLocalLLM,
  loadApiKeysFromKeychain: mockLoadApiKeysFromKeychain,
};

let subscribeCallback: (() => void) | null = null;

vi.mock("@/stores/settings-store", () => ({
  useSettingsStore: {
    getState: vi.fn(() => ({ ...defaultStoreState })),
    subscribe: vi.fn((cb: () => void) => {
      subscribeCallback = cb;
      return () => {
        subscribeCallback = null;
      };
    }),
  },
}));

import { initConfigSync, stopConfigSync } from "./config-sync";

describe("config-sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    subscribeCallback = null;
    mockGetAppDataDir.mockResolvedValue("/home/user/.vocalis");
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue("");
    mockPathExists.mockResolvedValue(false);
    mockLoadApiKeysFromKeychain.mockResolvedValue(undefined);
  });

  afterEach(() => {
    stopConfigSync();
    vi.useRealTimers();
  });

  describe("initConfigSync", () => {
    it("is a no-op in the browser", async () => {
      mockIsDesktop.mockReturnValue(false);
      await initConfigSync();

      expect(mockGetAppDataDir).not.toHaveBeenCalled();
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockLoadApiKeysFromKeychain).not.toHaveBeenCalled();
    });

    it("writes initial config when no config.yaml exists", async () => {
      mockIsDesktop.mockReturnValue(true);
      mockPathExists.mockResolvedValue(false);

      await initConfigSync();

      expect(mockWriteFile).toHaveBeenCalled();
      const [writtenPath, writtenContent] = mockWriteFile.mock.calls[0] as [string, string];
      expect(writtenPath).toBe("/home/user/.vocalis/config.yaml");
      const parsed = YAML.parse(writtenContent);
      expect(parsed.routing).toEqual(DEFAULT_ROUTING);
      expect(parsed.privacyMode).toBe(false);
    });

    it("loads existing config.yaml into the store", async () => {
      mockIsDesktop.mockReturnValue(true);
      mockPathExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(
        YAML.stringify({
          appearance: { theme: "light", hue: "teal" },
          privacyMode: true,
          routing: { tts: "elevenlabs" },
          dictation: { mode: "toggle" },
          models: { activeByTask: { tts: "kokoro-en" } },
        }),
      );

      await initConfigSync();

      expect(mockSetHue).toHaveBeenCalledWith("teal");
      expect(mockSetPrivacyMode).toHaveBeenCalledWith(true);
      expect(mockSetRouting).toHaveBeenCalledWith(
        expect.objectContaining({ tts: "elevenlabs", streamingAsr: DEFAULT_ROUTING.streamingAsr }),
      );
      expect(mockSetDictation).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "toggle" }),
      );
      expect(mockSetActiveByTask).toHaveBeenCalledWith({ tts: "kokoro-en" });
      expect(mockSetLocalLLM).toHaveBeenCalledWith(DEFAULT_LOCAL_LLM);
    });

    it("loads API keys from the keychain via the store action", async () => {
      mockIsDesktop.mockReturnValue(true);
      mockPathExists.mockResolvedValue(false);

      await initConfigSync();

      expect(mockLoadApiKeysFromKeychain).toHaveBeenCalled();
    });

    it("subscribes to store changes after loading", async () => {
      mockIsDesktop.mockReturnValue(true);
      mockPathExists.mockResolvedValue(false);

      const { useSettingsStore } = await import("@/stores/settings-store");
      await initConfigSync();

      expect(useSettingsStore.subscribe).toHaveBeenCalled();
    });

    it("preserves unsynced fields (theme) and loads audio/cache into the store", async () => {
      mockIsDesktop.mockReturnValue(true);
      mockPathExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(
        YAML.stringify({
          appearance: { theme: "light", hue: "blue" },
          audio: { inputDevice: "MacBook Pro Microphone" },
          cache: { ttsMaxBytes: 1234567 },
        }),
      );

      await initConfigSync();
      // audio + cache are store-owned synced fields now
      expect(mockSetAudioInputDevice).toHaveBeenCalledWith("MacBook Pro Microphone");
      expect(mockSetTtsCacheMaxBytes).toHaveBeenCalledWith(1234567);
      mockWriteFile.mockClear();

      if (subscribeCallback) subscribeCallback();
      await vi.advanceTimersByTimeAsync(600);

      const writtenContent = mockWriteFile.mock.calls[0][1] as string;
      const parsed = YAML.parse(writtenContent);
      // theme came from the file, hue comes from the store
      expect(parsed.appearance.theme).toBe("light");
      expect(parsed.appearance.hue).toBe("neutral");
      // The mocked store never applies setters, so the write carries the
      // store's own values for the synced fields.
      expect(parsed.cache.ttsMaxBytes).toBe(DEFAULT_TTS_CACHE_MAX_BYTES);
      expect(parsed.audio.inputDevice).toBe("");
      expect(parsed.localLlm).toEqual(DEFAULT_LOCAL_LLM);
    });
  });

  describe("debounced writing", () => {
    it("writes config after debounce when store changes", async () => {
      mockIsDesktop.mockReturnValue(true);
      mockPathExists.mockResolvedValue(false);

      await initConfigSync();
      mockWriteFile.mockClear();

      if (subscribeCallback) subscribeCallback();

      // Should not write immediately
      expect(mockWriteFile).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(600);

      expect(mockWriteFile).toHaveBeenCalled();
    });

    it("debounces multiple rapid changes into one write", async () => {
      mockIsDesktop.mockReturnValue(true);
      mockPathExists.mockResolvedValue(false);

      await initConfigSync();
      mockWriteFile.mockClear();

      if (subscribeCallback) {
        subscribeCallback();
        subscribeCallback();
        subscribeCallback();
      }

      await vi.advanceTimersByTimeAsync(600);

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
    });
  });

  describe("polling for external edits", () => {
    it("re-loads the store when the file changes on disk", async () => {
      mockIsDesktop.mockReturnValue(true);
      mockPathExists.mockResolvedValue(false);

      await initConfigSync();
      mockSetPrivacyMode.mockClear();

      // External edit appears on disk
      mockPathExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(YAML.stringify({ privacyMode: true }));

      await vi.advanceTimersByTimeAsync(2100);

      expect(mockSetPrivacyMode).toHaveBeenCalledWith(true);
    });
  });

  describe("stopConfigSync", () => {
    it("cleans up subscription and timers", async () => {
      mockIsDesktop.mockReturnValue(true);
      mockPathExists.mockResolvedValue(false);

      await initConfigSync();
      mockWriteFile.mockClear();

      stopConfigSync();

      if (subscribeCallback) subscribeCallback();
      await vi.advanceTimersByTimeAsync(600);

      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe("loadConfigFromFile edge cases", () => {
    it("handles invalid YAML gracefully", async () => {
      mockIsDesktop.mockReturnValue(true);
      mockPathExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("invalid: yaml: [broken");

      await initConfigSync();

      expect(mockSetHue).not.toHaveBeenCalled();
    });

    it("handles empty file content", async () => {
      mockIsDesktop.mockReturnValue(true);
      mockPathExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("");

      // Should not throw or patch the store
      await initConfigSync();
      expect(mockSetHue).not.toHaveBeenCalled();
    });
  });
});
