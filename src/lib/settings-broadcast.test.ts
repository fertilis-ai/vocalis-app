import { beforeEach, describe, expect, it, vi } from "vitest";
import { initSettingsBroadcast, initSettingsMirror } from "@/lib/settings-broadcast";
import { useSettingsStore } from "@/stores/settings-store";

const { emitMock, listenMock, invokeMock, loadAllApiKeysMock } = vi.hoisted(() => ({
  emitMock: vi.fn(() => Promise.resolve()),
  listenMock: vi.fn(),
  invokeMock: vi.fn(() => Promise.resolve()),
  loadAllApiKeysMock: vi.fn(() => Promise.resolve({} as Record<string, string>)),
}));

// Mock zustand persist to be a passthrough (avoids localStorage issues in tests)
vi.mock("zustand/middleware", () => ({
  persist: (fn: unknown) => fn,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: emitMock,
  listen: listenMock,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: () => false,
}));

vi.mock("@/lib/storage", () => ({
  isDesktop: () => true,
}));

vi.mock("@/lib/keychain", () => ({
  loadAllApiKeys: loadAllApiKeysMock,
  storeApiKey: vi.fn(() => Promise.resolve()),
  deleteApiKey: vi.fn(() => Promise.resolve()),
}));

type Handler = (event: { payload: unknown }) => void;

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("settings-broadcast", () => {
  const handlers: Record<string, Handler> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    listenMock.mockImplementation((event: string, handler: Handler) => {
      handlers[event] = handler;
      return Promise.resolve(() => {
        delete handlers[event];
      });
    });
    useSettingsStore.setState({
      hue: "neutral",
      privacyMode: false,
      activeByTask: {},
      apiKeys: {},
      dictation: {
        hotkey: "Alt+Space",
        mode: "hold",
        polish: false,
        polishModel: "openai/gpt-4o-mini",
        historyEnabled: true,
      },
    });
  });

  describe("initSettingsBroadcast (main window)", () => {
    it("emits the current settings and mirrors the tray toggles on init", async () => {
      const dispose = initSettingsBroadcast();
      await flush();

      expect(emitMock).toHaveBeenCalledWith(
        "settings-sync",
        expect.objectContaining({ privacyMode: false, hue: "neutral" }),
      );
      expect(invokeMock).toHaveBeenCalledWith("tray_set_toggles", {
        privacy: false,
        polish: false,
      });
      dispose();
    });

    it("re-emits when a synced setting changes, but not on identical state", async () => {
      const dispose = initSettingsBroadcast();
      await flush();
      emitMock.mockClear();
      invokeMock.mockClear();

      useSettingsStore.getState().setDictation({ polish: true });
      expect(emitMock).toHaveBeenCalledTimes(1);
      expect(invokeMock).toHaveBeenCalledWith("tray_set_toggles", {
        privacy: false,
        polish: true,
      });

      emitMock.mockClear();
      useSettingsStore.getState().setDictation({ polish: true });
      expect(emitMock).not.toHaveBeenCalled();
      dispose();
    });

    it("answers a sync request from another window with a fresh push", async () => {
      const dispose = initSettingsBroadcast();
      await flush();
      emitMock.mockClear();

      handlers["settings-sync-request"]?.({ payload: undefined });
      expect(emitMock).toHaveBeenCalledWith("settings-sync", expect.anything());
      dispose();
    });

    it("stops pushing after dispose", async () => {
      const dispose = initSettingsBroadcast();
      await flush();
      dispose();
      emitMock.mockClear();

      useSettingsStore.getState().setPrivacyMode(true);
      expect(emitMock).not.toHaveBeenCalled();
    });
  });

  describe("initSettingsMirror (HUD window)", () => {
    it("loads API keys from the keychain on init and requests a sync", async () => {
      const dispose = initSettingsMirror();
      await flush();

      expect(loadAllApiKeysMock).toHaveBeenCalled();
      expect(emitMock).toHaveBeenCalledWith("settings-sync-request");
      dispose();
    });

    it("applies a broadcast payload to the local store", async () => {
      const dispose = initSettingsMirror();
      await flush();

      handlers["settings-sync"]?.({
        payload: {
          hue: "teal",
          privacyMode: true,
          dictation: {
            hotkey: "Alt+D",
            mode: "toggle",
            polish: true,
            polishModel: "groq/llama-3.1-8b-instant",
            historyEnabled: false,
          },
          activeByTask: { "asr-streaming": "zipformer-streaming-en" },
          apiProviders: [],
        },
      });

      const state = useSettingsStore.getState();
      expect(state.hue).toBe("teal");
      expect(state.privacyMode).toBe(true);
      expect(state.dictation.mode).toBe("toggle");
      expect(state.activeByTask["asr-streaming"]).toBe("zipformer-streaming-en");
      dispose();
    });

    it("reloads keychain keys when the provider set changes", async () => {
      const dispose = initSettingsMirror();
      await flush();
      loadAllApiKeysMock.mockClear();

      const payload = {
        hue: "neutral",
        privacyMode: false,
        dictation: useSettingsStore.getState().dictation,
        activeByTask: {},
        apiProviders: ["openai"],
      };
      handlers["settings-sync"]?.({ payload });
      expect(loadAllApiKeysMock).toHaveBeenCalledTimes(1);

      handlers["settings-sync"]?.({ payload });
      expect(loadAllApiKeysMock).toHaveBeenCalledTimes(1);
      dispose();
    });
  });
});
