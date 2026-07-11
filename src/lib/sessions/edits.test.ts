import { describe, expect, it } from "vitest";
import type { SpeakerRef, Transcript } from "@/lib/schemas/session";
import {
  assignPerson,
  editSegmentText,
  reassignSpeaker,
  renameSpeaker,
} from "@/lib/sessions/edits";
import { mergeSpeakers } from "@/lib/sessions/transcript";

const speakers: SpeakerRef[] = [{ label: "A" }, { label: "B" }];
const transcript: Transcript = [
  { id: "1", speakerLabel: "A", text: "one", startMs: 0, endMs: 1 },
  { id: "2", speakerLabel: "B", text: "two", startMs: 1, endMs: 2 },
  { id: "3", speakerLabel: "A", text: "three", startMs: 2, endMs: 3 },
];

describe("renameSpeaker", () => {
  it("sets a name and clears it when blank", () => {
    expect(renameSpeaker(speakers, "A", "Alice")[0].name).toBe("Alice");
    const named = renameSpeaker(speakers, "A", "Alice");
    expect(renameSpeaker(named, "A", "  ")[0].name).toBeUndefined();
  });
});

describe("assignPerson", () => {
  it("assigns and clears a personId", () => {
    expect(assignPerson(speakers, "B", "p1")[1].personId).toBe("p1");
    const assigned = assignPerson(speakers, "B", "p1");
    expect(assignPerson(assigned, "B", null)[1].personId).toBeUndefined();
  });
});

describe("reassignSpeaker + mergeSpeakers", () => {
  it("merges B into A across segments and drops the empty label", () => {
    const merged = reassignSpeaker(transcript, "B", "A");
    expect(merged.every((s) => s.speakerLabel === "A")).toBe(true);
    expect(mergeSpeakers(speakers, merged).map((s) => s.label)).toEqual(["A"]);
  });
});

describe("editSegmentText", () => {
  it("replaces text and marks the segment edited", () => {
    const out = editSegmentText(transcript, "2", "TWO");
    expect(out[1]).toMatchObject({ text: "TWO", edited: true });
    expect(out[0].edited).toBeUndefined();
  });
});
