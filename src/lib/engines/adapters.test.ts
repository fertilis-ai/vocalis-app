import { describe, expect, it, vi } from "vitest";
import { deepgramDiarize, deepgramTranscribe, mergeWordsBySpeaker } from "./deepgram";
import {
  elevenlabsCreateClone,
  elevenlabsDeleteVoice,
  elevenlabsListVoices,
  elevenlabsSynthesize,
  elevenlabsTranscribe,
} from "./elevenlabs";
import { groqTranscribe } from "./groq";
import { openaiSynthesize, openaiTranscribe } from "./openai";

// Adapter unit tests: request shape + response mapping + error mapping, all
// against a mocked fetch. No network — no live-API tests in CI (spec M2 item 9).

function jsonResponse(body: unknown, init: Partial<Response> = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

function bytesResponse(bytes: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer,
    text: async () => "",
  } as unknown as Response;
}

/** A mocked fetch whose recorded calls carry (url, init) types. */
function mockFetch(handler: () => Response) {
  return vi.fn(
    (_url: string | URL, _init: RequestInit): Promise<Response> =>
      Promise.resolve(handler()),
  );
}

const AUDIO = new Uint8Array([1, 2, 3, 4]);
const asFetch = (fn: ReturnType<typeof mockFetch>) =>
  fn as unknown as typeof globalThis.fetch;

describe("openaiTranscribe", () => {
  it("posts multipart to the transcriptions endpoint and maps words", async () => {
    const fetch = mockFetch(() =>
      jsonResponse({
        text: "hello world",
        duration: 2,
        words: [
          { word: "hello", start: 0 },
          { word: "world", start: 0.5 },
        ],
      }),
    );
    const result = await openaiTranscribe({
      fetch: asFetch(fetch),
      apiKey: "sk-test",
      bytes: AUDIO,
      filename: "clip.wav",
      language: "en",
    });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk-test" });
    const body = init.body as FormData;
    expect(body.get("model")).toBe("whisper-1");
    expect(body.get("language")).toBe("en");
    expect(result.text).toBe("hello world");
    expect(result.words).toEqual([
      { text: "hello", start: 0 },
      { text: "world", start: 0.5 },
    ]);
    expect(result.rtf).toBeGreaterThanOrEqual(0);
  });

  it("omits the language param when auto-detecting", async () => {
    const fetch = mockFetch(() => jsonResponse({ text: "" }));
    await openaiTranscribe({
      fetch: asFetch(fetch),
      apiKey: "k",
      bytes: AUDIO,
      filename: "a.wav",
      language: "auto",
    });
    const body = fetch.mock.calls[0][1].body as FormData;
    expect(body.has("language")).toBe(false);
  });

  it("maps a non-2xx into a tagged error", async () => {
    const fetch = mockFetch(() =>
      jsonResponse({ error: "bad key" }, { ok: false, status: 401 }),
    );
    await expect(
      openaiTranscribe({
        fetch: asFetch(fetch),
        apiKey: "k",
        bytes: AUDIO,
        filename: "a.wav",
      }),
    ).rejects.toThrow(/OpenAI request failed \(401\)/);
  });
});

describe("openaiSynthesize", () => {
  it("requests wav bytes with the chosen voice", async () => {
    const fetch = mockFetch(() => bytesResponse(new Uint8Array([9, 9])));
    const audio = await openaiSynthesize({
      fetch: asFetch(fetch),
      apiKey: "k",
      text: "hi",
      voice: "nova",
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ voice: "nova", input: "hi", response_format: "wav" });
    expect(audio.ext).toBe("wav");
    expect(Array.from(audio.bytes)).toEqual([9, 9]);
  });
});

describe("groqTranscribe", () => {
  it("targets the Groq OpenAI-compatible endpoint with whisper-large-v3", async () => {
    const fetch = mockFetch(() => jsonResponse({ text: "bonjour", duration: 1 }));
    const result = await groqTranscribe({
      fetch: asFetch(fetch),
      apiKey: "gsk",
      bytes: AUDIO,
      filename: "a.wav",
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect((init.body as FormData).get("model")).toBe("whisper-large-v3");
    expect(result.text).toBe("bonjour");
  });
});

describe("elevenlabsTranscribe", () => {
  it("uses the xi-api-key header and drops spacing tokens", async () => {
    const fetch = mockFetch(() =>
      jsonResponse({
        text: "hi there",
        words: [
          { text: "hi", start: 0, type: "word" },
          { text: " ", start: 0.2, type: "spacing" },
          { text: "there", start: 0.3, type: "word" },
        ],
      }),
    );
    const result = await elevenlabsTranscribe({
      fetch: asFetch(fetch),
      apiKey: "xi",
      bytes: AUDIO,
      filename: "a.wav",
    });
    expect(fetch.mock.calls[0][1].headers).toMatchObject({ "xi-api-key": "xi" });
    expect(result.words).toEqual([
      { text: "hi", start: 0 },
      { text: "there", start: 0.3 },
    ]);
  });
});

describe("elevenlabsSynthesize", () => {
  it("posts to the voice-specific endpoint and returns mp3 bytes", async () => {
    const fetch = mockFetch(() => bytesResponse(new Uint8Array([7])));
    const audio = await elevenlabsSynthesize({
      fetch: asFetch(fetch),
      apiKey: "xi",
      text: "salut",
      voice: "voice123",
    });
    expect(fetch.mock.calls[0][0]).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice123",
    );
    expect(audio.ext).toBe("mp3");
  });
});

describe("elevenlabsCreateClone", () => {
  it("posts multipart to /voices/add and returns the voice id", async () => {
    const fetch = mockFetch(() => jsonResponse({ voice_id: "clone-42" }));
    const voiceId = await elevenlabsCreateClone({
      fetch: asFetch(fetch),
      apiKey: "xi",
      name: "Martin (clone)",
      bytes: AUDIO,
      filename: "clip-0.wav",
    });
    expect(voiceId).toBe("clone-42");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/voices/add");
    expect(init.headers).toMatchObject({ "xi-api-key": "xi" });
    const form = init.body as FormData;
    expect(form.get("name")).toBe("Martin (clone)");
    expect(form.get("files")).toBeInstanceOf(Blob);
    // Empty optionals are omitted entirely (inspiration.md §8).
    expect(form.has("description")).toBe(false);
  });

  it("throws when the response carries no voice_id", async () => {
    const fetch = mockFetch(() => jsonResponse({}));
    await expect(
      elevenlabsCreateClone({
        fetch: asFetch(fetch),
        apiKey: "xi",
        name: "x",
        bytes: AUDIO,
        filename: "a.wav",
      }),
    ).rejects.toThrow(/voice_id/);
  });
});

describe("elevenlabsListVoices", () => {
  it("maps voice_id/name/category", async () => {
    const fetch = mockFetch(() =>
      jsonResponse({
        voices: [
          { voice_id: "v1", name: "Rachel", category: "premade" },
          { voice_id: "v2", name: "Martin (clone)", category: "cloned" },
        ],
      }),
    );
    const voices = await elevenlabsListVoices({ fetch: asFetch(fetch), apiKey: "xi" });
    expect(voices).toEqual([
      { voiceId: "v1", name: "Rachel", category: "premade" },
      { voiceId: "v2", name: "Martin (clone)", category: "cloned" },
    ]);
  });
});

describe("elevenlabsDeleteVoice", () => {
  it("DELETEs the voice endpoint", async () => {
    const fetch = mockFetch(() => jsonResponse({ status: "ok" }));
    await elevenlabsDeleteVoice({ fetch: asFetch(fetch), apiKey: "xi", voiceId: "v2" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/voices/v2");
    expect(init.method).toBe("DELETE");
  });
});

describe("deepgramTranscribe", () => {
  it("sends raw bytes with a Token header and maps transcript", async () => {
    const fetch = mockFetch(() =>
      jsonResponse({
        metadata: { duration: 3 },
        results: {
          channels: [
            {
              alternatives: [
                {
                  transcript: "one two",
                  words: [
                    { word: "one", start: 0, end: 0.5 },
                    { word: "two", start: 0.5, end: 1 },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );
    const result = await deepgramTranscribe({
      fetch: asFetch(fetch),
      apiKey: "dg",
      bytes: AUDIO,
    });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toContain("https://api.deepgram.com/v1/listen?");
    expect(init.headers).toMatchObject({ Authorization: "Token dg" });
    expect(result.text).toBe("one two");
    expect(result.words).toHaveLength(2);
  });
});

describe("deepgramDiarize / mergeWordsBySpeaker", () => {
  it("collapses consecutive same-speaker words into segments", () => {
    const segments = mergeWordsBySpeaker([
      { word: "a", start: 0, end: 1, speaker: 0 },
      { word: "b", start: 1, end: 2, speaker: 0 },
      { word: "c", start: 2, end: 3, speaker: 1 },
      { word: "d", start: 3, end: 4, speaker: 0 },
    ]);
    expect(segments).toEqual([
      { start: 0, end: 2, speaker: 0 },
      { start: 2, end: 3, speaker: 1 },
      { start: 3, end: 4, speaker: 0 },
    ]);
  });

  it("counts distinct speakers", async () => {
    const fetch = mockFetch(() =>
      jsonResponse({
        metadata: { duration: 4 },
        results: {
          channels: [
            {
              alternatives: [
                {
                  words: [
                    { word: "a", start: 0, end: 1, speaker: 0 },
                    { word: "b", start: 1, end: 2, speaker: 1 },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );
    const result = await deepgramDiarize({
      fetch: asFetch(fetch),
      apiKey: "dg",
      bytes: AUDIO,
    });
    expect(result.numSpeakers).toBe(2);
    expect(result.segments).toHaveLength(2);
  });
});
