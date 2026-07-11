import { describe, expect, it } from "vitest";
import type { DiarizationSegment, WordSpan } from "@/lib/engines/local";
import { mergeWordsWithDiarization } from "@/lib/import/segments";

const words = (list: [string, number][]): WordSpan[] =>
  list.map(([text, start]) => ({ text, start }));

describe("mergeWordsWithDiarization", () => {
  it("returns nothing for empty input", () => {
    expect(mergeWordsWithDiarization([], [])).toEqual([]);
  });

  it("groups all words into one 'A' turn without diarization", () => {
    const turns = mergeWordsWithDiarization(words([["hello", 0], ["world", 0.5]]), []);
    expect(turns).toHaveLength(1);
    expect(turns[0].speakerLabel).toBe("A");
    expect(turns[0].text).toBe("hello world");
    expect(turns[0].startMs).toBe(0);
  });

  it("splits words across diarization spans into speaker turns", () => {
    const diar: DiarizationSegment[] = [
      { start: 0, end: 1, speaker: 3 },
      { start: 1, end: 2, speaker: 7 },
    ];
    const turns = mergeWordsWithDiarization(
      words([["hi", 0.1], ["there", 0.6], ["yes", 1.2], ["indeed", 1.6]]),
      diar,
    );
    expect(turns.map((t) => t.speakerLabel)).toEqual(["A", "B"]);
    expect(turns[0].text).toBe("hi there");
    expect(turns[1].text).toBe("yes indeed");
  });

  it("renumbers speakers by first appearance (span speaker 7 seen first → A)", () => {
    const diar: DiarizationSegment[] = [
      { start: 0, end: 1, speaker: 7 },
      { start: 1, end: 2, speaker: 2 },
      { start: 2, end: 3, speaker: 7 },
    ];
    const turns = mergeWordsWithDiarization(
      words([["one", 0.5], ["two", 1.5], ["three", 2.5]]),
      diar,
    );
    expect(turns.map((t) => t.speakerLabel)).toEqual(["A", "B", "A"]);
  });

  it("attributes a word outside all spans to the nearest span", () => {
    const diar: DiarizationSegment[] = [{ start: 0, end: 1, speaker: 0 }];
    const turns = mergeWordsWithDiarization(words([["late", 5]]), diar);
    expect(turns).toHaveLength(1);
    expect(turns[0].speakerLabel).toBe("A");
  });
});
