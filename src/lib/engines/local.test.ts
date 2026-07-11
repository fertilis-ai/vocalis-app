import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock zustand persist to be a passthrough (avoids localStorage issues in tests)
vi.mock("zustand/middleware", () => ({
  persist: (fn: unknown) => fn,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
  Channel: class {
    onmessage: unknown;
  },
}));

import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/stores/settings-store";
import {
  asrTranscribeFile,
  asrTranscribeFileStreaming,
  finalizeDictation,
  injectText,
  startAsrPipeline,
  startDictation,
  ttsSynthesize,
} from "./local";

const mockInvoke = vi.mocked(invoke);

describe("local engine bridge model resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ activeByTask: {} });
  });

  it("passes null models when no slot is configured (Rust falls back)", async () => {
    mockInvoke.mockResolvedValue(1);
    await startAsrPipeline({ onEvent: () => {} });
    expect(mockInvoke).toHaveBeenCalledWith(
      "asr_pipeline_start",
      expect.objectContaining({ asrModel: null, vadModel: null }),
    );
  });

  it("uses the active-model slots from settings", async () => {
    useSettingsStore.setState({
      activeByTask: {
        "asr-streaming": "zipformer-en-2023-06-26",
        vad: "silero-vad-v5",
        tts: "kokoro-en-v0_19",
      },
    });
    mockInvoke.mockResolvedValue(1);
    await startAsrPipeline({ onEvent: () => {} });
    expect(mockInvoke).toHaveBeenCalledWith(
      "asr_pipeline_start",
      expect.objectContaining({
        asrModel: "zipformer-en-2023-06-26",
        vadModel: "silero-vad-v5",
      }),
    );

    mockInvoke.mockResolvedValue({ path: "/x.wav", durationSecs: 1, cached: false });
    await ttsSynthesize("hello");
    expect(mockInvoke).toHaveBeenCalledWith(
      "tts_synthesize",
      expect.objectContaining({ model: "kokoro-en-v0_19" }),
    );
  });

  it("inline override wins over the active slot", async () => {
    useSettingsStore.setState({
      activeByTask: { "asr-streaming": "zipformer-en-2023-06-26" },
    });
    mockInvoke.mockResolvedValue(1);
    await startAsrPipeline({ asrModel: "other-model", onEvent: () => {} });
    expect(mockInvoke).toHaveBeenCalledWith(
      "asr_pipeline_start",
      expect.objectContaining({ asrModel: "other-model" }),
    );
  });

  it("uses the channel bridge for dictation and active punctuation model", async () => {
    useSettingsStore.setState({
      activeByTask: {
        "asr-batch": "whisper-small-int8",
        vad: "silero-vad-v5",
        punctuation: "ct-transformer-zh-en",
      },
    });
    mockInvoke.mockResolvedValueOnce(42);
    await startDictation({ onEvent: () => {} });
    expect(mockInvoke).toHaveBeenCalledWith(
      "dictation_start",
      expect.objectContaining({ asrModel: "whisper-small-int8", vadModel: "silero-vad-v5" }),
    );

    mockInvoke.mockResolvedValueOnce("Punctuated text.");
    await expect(finalizeDictation(42)).resolves.toBe("Punctuated text.");
    expect(mockInvoke).toHaveBeenCalledWith("dictation_finalize", {
      id: 42,
      punctuationModel: "ct-transformer-zh-en",
    });
  });

  it("batch transcription uses the asr-batch slot and passes language", async () => {
    useSettingsStore.setState({
      activeByTask: { "asr-batch": "whisper-small-int8" },
    });
    const result = { text: "hi", words: [], durationSecs: 2, processingMs: 400, rtf: 0.2 };
    mockInvoke.mockResolvedValueOnce(result);
    await expect(
      asrTranscribeFile("/clip.wav", { language: "fr" }),
    ).resolves.toEqual(result);
    expect(mockInvoke).toHaveBeenCalledWith("asr_transcribe_file", {
      path: "/clip.wav",
      model: "whisper-small-int8",
      language: "fr",
    });
  });

  it("streaming file transcription uses the asr-streaming slot", async () => {
    useSettingsStore.setState({
      activeByTask: { "asr-streaming": "zipformer-en-2023-06-26" },
    });
    mockInvoke.mockResolvedValueOnce({
      text: "hi",
      words: [{ text: "hi", start: 0.1 }],
      durationSecs: 1,
      processingMs: 100,
      rtf: 0.1,
    });
    await asrTranscribeFileStreaming("/clip.wav");
    expect(mockInvoke).toHaveBeenCalledWith("asr_transcribe_file_streaming", {
      path: "/clip.wav",
      model: "zipformer-en-2023-06-26",
    });
  });

  it("invokes native clipboard injection", async () => {
    const result = { injected: true, copied: true, accessibilityTrusted: true };
    mockInvoke.mockResolvedValueOnce(result);
    await expect(injectText("hello")).resolves.toEqual(result);
    expect(mockInvoke).toHaveBeenCalledWith("inject_text", { text: "hello" });
  });
});
