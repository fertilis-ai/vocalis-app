import { describe, expect, it } from "vitest";
import type { Person } from "@/lib/schemas/people";
import type { SpeakerRef, TranscriptSegment } from "@/lib/schemas/session";
import {
  mergeSpeakers,
  speakerDisplay,
  speakersOf,
  toTranscript,
} from "@/lib/sessions/transcript";

const seg = (label: string, personId?: string): TranscriptSegment => ({
  id: crypto.randomUUID(),
  speakerLabel: label,
  personId,
  text: "hi",
  startMs: 0,
  endMs: 1,
});

describe("toTranscript", () => {
  it("assigns uuids and the provisional flag", () => {
    const out = toTranscript(
      [{ speakerLabel: "A", text: "hi", startMs: 0, endMs: 100, personId: "p1" }],
      true,
    );
    expect(out[0].id).toMatch(/[0-9a-f-]{36}/);
    expect(out[0].provisional).toBe(true);
    expect(out[0].personId).toBe("p1");
  });
});

describe("speakersOf", () => {
  it("lists distinct labels in first-appearance order", () => {
    const refs = speakersOf([seg("B"), seg("A"), seg("B")]);
    expect(refs.map((r) => r.label)).toEqual(["B", "A"]);
  });
});

describe("mergeSpeakers", () => {
  it("preserves prior naming for surviving labels and appends new ones", () => {
    const existing: SpeakerRef[] = [
      { label: "A", name: "Alice", personId: "p1" },
    ];
    const merged = mergeSpeakers(existing, [seg("A"), seg("B")]);
    expect(merged).toEqual([
      { label: "A", name: "Alice", personId: "p1" },
      { label: "B", personId: undefined },
    ]);
  });

  it("drops labels no longer present", () => {
    const existing: SpeakerRef[] = [{ label: "A", name: "Alice" }];
    const merged = mergeSpeakers(existing, [seg("B")]);
    expect(merged.map((r) => r.label)).toEqual(["B"]);
  });
});

describe("speakerDisplay", () => {
  const people: Record<string, Person> = {
    p1: {
      id: "p1",
      name: "Alice",
      color: "var(--chart-3)",
      createdAt: "2026-07-10T00:00:00.000Z",
      enrollment: null,
      clones: {},
    },
  };

  it("prefers an explicit ref name/color", () => {
    const refs: SpeakerRef[] = [{ label: "A", name: "Boss", color: "#f00" }];
    expect(speakerDisplay("A", refs, people)).toEqual({ name: "Boss", color: "#f00" });
  });

  it("falls back to a matched person", () => {
    const refs: SpeakerRef[] = [{ label: "A", personId: "p1" }];
    expect(speakerDisplay("A", refs, people)).toEqual({
      name: "Alice",
      color: "var(--chart-3)",
    });
  });

  it("defaults to Speaker <label> with a palette color", () => {
    const refs: SpeakerRef[] = [{ label: "A" }, { label: "B" }];
    expect(speakerDisplay("B", refs, people).name).toBe("Speaker B");
    expect(speakerDisplay("B", refs, people).color).toBe("var(--chart-2)");
  });
});
