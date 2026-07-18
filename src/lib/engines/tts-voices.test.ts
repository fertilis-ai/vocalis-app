import { describe, expect, it } from "vitest";
import type { InstalledModel } from "@/lib/schemas/catalog";
import type { Person } from "@/lib/schemas/people";
import type { TtsVoice } from "@/lib/schemas/voices";
import {
  buildVoiceGroups,
  cloneLibraryVoices,
  installedVoiceGroups,
  previewSentence,
  voicesForModel,
  voiceStorageId,
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

// ── Clone voices + library state (M5 item 4) ────────────────────────────────

function personWithClones(overrides: Partial<Person> = {}): Person {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "Martin",
    color: "#123456",
    createdAt: "2026-07-16T00:00:00.000Z",
    enrollment: null,
    cloneRef: {
      samples: [{ path: "clone-ref/clip-0.wav", durationMs: 20000 }],
      transcript: "hello there",
      consentConfirmed: true,
    },
    clones: {
      zipvoice: { refAudio: "clone-ref/clip-0.wav", refText: "hello there" },
      elevenlabs: { voiceId: "el-voice-1" },
    },
    ...overrides,
  };
}

const withCloneModel: InstalledModel[] = [
  { task: "tts", id: "kokoro-en-v0_19", sizeBytes: 1 },
  { task: "clone-tts", id: "zipvoice-distill-int8", sizeBytes: 1 },
];

describe("buildVoiceGroups clone voices", () => {
  const person = personWithClones();

  it("lists both clone voices with person-derived labels and targets", () => {
    const groups = buildVoiceGroups(withCloneModel, { elevenlabs: "xi" }, false, {
      people: [person],
    });
    const clones = groups.find((g) => g.id === "clones");
    if (!clones) throw new Error("expected a clones group");
    expect(clones.voices.map((v) => v.key)).toEqual([
      `clone:zipvoice:${person.id}`,
      `clone:elevenlabs:${person.id}`,
    ]);
    expect(clones.voices[0]).toMatchObject({
      kind: "clone",
      personId: person.id,
      target: { kind: "clone-local", refText: "hello there" },
    });
    expect(
      (clones.voices[0].target as { refAudio: string }).refAudio,
    ).toContain(`${person.id}/clone-ref/clip-0.wav`);
    expect(clones.voices[1].target).toEqual({
      kind: "clone-api",
      provider: "elevenlabs",
      voiceId: "el-voice-1",
    });
  });

  it("omits the ZipVoice clone when no clone-tts model is installed", () => {
    const groups = buildVoiceGroups(
      [{ task: "tts", id: "kokoro-en-v0_19", sizeBytes: 1 }],
      { elevenlabs: "xi" },
      false,
      { people: [person] },
    );
    const clones = groups.find((g) => g.id === "clones");
    expect(clones?.voices.map((v) => v.key)).toEqual([
      `clone:elevenlabs:${person.id}`,
    ]);
  });

  it("privacy mode hides ElevenLabs clones but keeps local ones", () => {
    const groups = buildVoiceGroups(withCloneModel, { elevenlabs: "xi" }, true, {
      people: [person],
    });
    const clones = groups.find((g) => g.id === "clones");
    expect(clones?.voices.map((v) => v.key)).toEqual([
      `clone:zipvoice:${person.id}`,
    ]);
  });

  it("omits ElevenLabs clones without a key", () => {
    const groups = buildVoiceGroups(withCloneModel, {}, false, {
      people: [person],
    });
    const clones = groups.find((g) => g.id === "clones");
    expect(clones?.voices.map((v) => v.key)).toEqual([
      `clone:zipvoice:${person.id}`,
    ]);
  });

  it("has no clone group when nobody carries a clone", () => {
    const groups = buildVoiceGroups(withCloneModel, {}, false, {
      people: [personWithClones({ clones: {}, cloneRef: undefined })],
    });
    expect(groups.find((g) => g.id === "clones")).toBeUndefined();
  });
});

describe("library state merge", () => {
  const person = personWithClones();

  it("decorates voices with favorites and default speed, favorites first", () => {
    const library: Record<string, TtsVoice> = {
      "local:kokoro-en-v0_19:3": {
        id: "local:kokoro-en-v0_19:3",
        label: "Sarah (US, female)",
        engineId: "local.kokoro-en",
        kind: "stock",
        langs: ["en-US"],
        params: { speed: 1.25 },
        favorite: true,
      },
    };
    const [local] = buildVoiceGroups(withCloneModel, {}, false, {
      people: [person],
      library,
    });
    // The favorite floats to the top of its group.
    expect(local.voices[0]).toMatchObject({
      key: "local:kokoro-en-v0_19:3",
      favorite: true,
      defaultSpeed: 1.25,
    });
    // Everyone else keeps sid order behind it.
    expect(local.voices[1].key).toBe("local:kokoro-en-v0_19:0");
  });
});

describe("voiceStorageId", () => {
  it("stores local sids, API voice ids, and full clone keys", () => {
    const person = personWithClones();
    const groups = buildVoiceGroups(withCloneModel, { openai: "sk" }, false, {
      people: [person],
    });
    const local = groups[0].voices[2];
    expect(voiceStorageId(local)).toBe("2");
    const clone = groups.find((g) => g.id === "clones")?.voices[0];
    expect(voiceStorageId(clone as NonNullable<typeof clone>)).toBe(
      `clone:zipvoice:${person.id}`,
    );
    const api = groups.find((g) => g.id === "api:openai")?.voices[0];
    expect(voiceStorageId(api as NonNullable<typeof api>)).toBe("alloy");
  });
});

describe("cloneLibraryVoices", () => {
  it("emits one library entry per clone with the person id", () => {
    const entries = cloneLibraryVoices([personWithClones()]);
    expect(entries.map((e) => e.id)).toEqual([
      "clone:zipvoice:550e8400-e29b-41d4-a716-446655440000",
      "clone:elevenlabs:550e8400-e29b-41d4-a716-446655440000",
    ]);
    expect(entries[0]).toMatchObject({
      kind: "clone",
      engineId: "local.zipvoice",
      favorite: false,
    });
  });

  it("emits nothing for people without clones", () => {
    expect(
      cloneLibraryVoices([personWithClones({ clones: {}, cloneRef: undefined })]),
    ).toEqual([]);
  });
});

describe("previewSentence", () => {
  it("speaks French for fr voices and English otherwise", () => {
    expect(previewSentence("fr-FR")).toMatch(/Bonjour/);
    expect(previewSentence("en-US")).toMatch(/preview/);
    expect(previewSentence("")).toMatch(/preview/);
  });
});
