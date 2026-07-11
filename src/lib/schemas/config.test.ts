import { describe, expect, it } from "vitest";
import {
  DEFAULT_DICTATION,
  DEFAULT_LOCAL_LLM,
  DEFAULT_ROUTING,
  DEFAULT_TTS_CACHE_MAX_BYTES,
  DEFAULT_VOICE_CHAT,
  defaultConfig,
  parseConfig,
} from "./config";

describe("config schema", () => {
  it("parses an empty object to full defaults", () => {
    const config = parseConfig({});
    expect(config).toEqual({
      appearance: { theme: "dark", hue: "neutral" },
      privacyMode: false,
      routing: DEFAULT_ROUTING,
      dictation: DEFAULT_DICTATION,
      models: { activeByTask: {} },
      audio: { inputDevice: "" },
      cache: { ttsMaxBytes: DEFAULT_TTS_CACHE_MAX_BYTES },
      localLlm: DEFAULT_LOCAL_LLM,
      voiceChat: DEFAULT_VOICE_CHAT,
    });
  });

  it("keeps values from a partial file and defaults the rest", () => {
    const config = parseConfig({
      privacyMode: true,
      appearance: { hue: "teal" },
      routing: { tts: "elevenlabs" },
    });
    expect(config.privacyMode).toBe(true);
    expect(config.appearance).toEqual({ theme: "dark", hue: "teal" });
    expect(config.routing.tts).toBe("elevenlabs");
    expect(config.routing.streamingAsr).toBe(DEFAULT_ROUTING.streamingAsr);
    expect(config.dictation).toEqual(DEFAULT_DICTATION);
  });

  it("falls back per-field on bad values without dropping siblings", () => {
    const config = parseConfig({
      privacyMode: "yes please", // not a boolean
      appearance: { theme: "purple", hue: "teal" }, // bad theme, good hue
      dictation: { hotkey: "F5", mode: "double-tap" }, // bad mode, good hotkey
      cache: { ttsMaxBytes: -5 }, // not positive
    });
    expect(config.privacyMode).toBe(false);
    expect(config.appearance.theme).toBe("dark");
    expect(config.appearance.hue).toBe("teal");
    expect(config.dictation.hotkey).toBe("F5");
    expect(config.dictation.mode).toBe("hold");
    expect(config.cache.ttsMaxBytes).toBe(DEFAULT_TTS_CACHE_MAX_BYTES);
  });

  it("returns full defaults for non-object input", () => {
    expect(parseConfig(null)).toEqual(defaultConfig());
    expect(parseConfig(undefined)).toEqual(defaultConfig());
    expect(parseConfig("just a string")).toEqual(defaultConfig());
    expect(parseConfig(42)).toEqual(defaultConfig());
  });

  it("parses activeByTask as a string record", () => {
    const config = parseConfig({
      models: { activeByTask: { streamingAsr: "zipformer-streaming-en" } },
    });
    expect(config.models.activeByTask).toEqual({
      streamingAsr: "zipformer-streaming-en",
    });
  });
});
