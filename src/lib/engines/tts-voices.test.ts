import { describe, expect, it } from "vitest";
import type { InstalledModel } from "@/lib/schemas/catalog";
import {
  buildVoiceGroups,
  installedVoiceGroups,
  voicesForModel,
} from "./tts-voices";

describe("voicesForModel", () => {
  it("lists all 11 Kokoro voices in sid order", () => {
    const voices = voicesForModel("kokoro-en-v0_19");
    expect(voices).toHaveLength(11);
    expect(voices.map((v) => v.sid)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(voices[0].modelId).toBe("kokoro-en-v0_19");
    expect(voices[1].label).toContain("Bella");
  });

  it("gives Piper FR a single French voice", () => {
    const voices = voicesForModel("piper-fr-siwis");
    expect(voices).toEqual([
      { modelId: "piper-fr-siwis", sid: 0, label: "SIWIS (French)", lang: "fr-FR" },
    ]);
  });

  it("falls back to one default voice for unknown models", () => {
    const voices = voicesForModel("some-custom-tts");
    expect(voices).toHaveLength(1);
    expect(voices[0]).toMatchObject({ modelId: "some-custom-tts", sid: 0 });
  });
});

describe("installedVoiceGroups", () => {
  const installed: InstalledModel[] = [
    { task: "tts", id: "kokoro-en-v0_19", sizeBytes: 1 },
    { task: "tts", id: "piper-fr-siwis", sizeBytes: 1 },
    { task: "vad", id: "silero-vad-v5", sizeBytes: 1 },
  ];

  it("groups only TTS models, one group per model", () => {
    const groups = installedVoiceGroups(installed);
    expect(groups.map((g) => g.modelId)).toEqual([
      "kokoro-en-v0_19",
      "piper-fr-siwis",
    ]);
    expect(groups[0].voices).toHaveLength(11);
  });

  it("is empty when no TTS models are installed", () => {
    expect(installedVoiceGroups([{ task: "vad", id: "x", sizeBytes: 1 }])).toEqual(
      [],
    );
  });
});

describe("buildVoiceGroups", () => {
  const installed: InstalledModel[] = [
    { task: "tts", id: "kokoro-en-v0_19", sizeBytes: 1 },
  ];

  it("appends cloud groups for providers with a key when privacy is off", () => {
    const groups = buildVoiceGroups(
      installed,
      { openai: "sk", elevenlabs: "xi" },
      false,
    );
    expect(groups.map((g) => g.id)).toEqual([
      "local:kokoro-en-v0_19",
      "api:openai",
      "api:elevenlabs",
    ]);
    const openai = groups.find((g) => g.id === "api:openai");
    expect(openai?.voices).toHaveLength(6);
    expect(openai?.voices[0].target).toMatchObject({ kind: "api", provider: "openai" });
  });

  it("omits providers without a key", () => {
    const groups = buildVoiceGroups(installed, { openai: "sk" }, false);
    expect(groups.map((g) => g.id)).toEqual(["local:kokoro-en-v0_19", "api:openai"]);
  });

  it("hides all cloud groups under privacy mode", () => {
    const groups = buildVoiceGroups(
      installed,
      { openai: "sk", elevenlabs: "xi" },
      true,
    );
    expect(groups.map((g) => g.id)).toEqual(["local:kokoro-en-v0_19"]);
  });

  it("builds local voice targets keyed by model and sid", () => {
    const [local] = buildVoiceGroups(installed, {}, false);
    expect(local.voices[1]).toMatchObject({
      kind: "local",
      key: "local:kokoro-en-v0_19:1",
      target: { kind: "local", modelId: "kokoro-en-v0_19", sid: 1 },
    });
  });
});
