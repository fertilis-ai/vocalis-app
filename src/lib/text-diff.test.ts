import { describe, expect, it } from "vitest";
import { diffWords } from "./text-diff";

describe("diffWords", () => {
  it("marks identical text as one same span", () => {
    expect(diffWords("hello world", "hello world")).toEqual([
      { type: "same", text: "hello world" },
    ]);
  });

  it("marks punctuation/casing changes as removed+added pairs", () => {
    const spans = diffWords("hello world how are you", "Hello world. How are you?");
    expect(spans).toEqual([
      { type: "removed", text: "hello world how" },
      { type: "added", text: "Hello world. How" },
      { type: "same", text: "are" },
      { type: "removed", text: "you" },
      { type: "added", text: "you?" },
    ]);
  });

  it("handles empty sides", () => {
    expect(diffWords("", "one two")).toEqual([{ type: "added", text: "one two" }]);
    expect(diffWords("one two", "")).toEqual([{ type: "removed", text: "one two" }]);
    expect(diffWords("", "")).toEqual([]);
  });

  it("keeps the round trip lossless", () => {
    const before = "the quick brown fox jumps over the lazy dog";
    const after = "The quick brown fox, jumps over the lazy dog.";
    const spans = diffWords(before, after);
    const rebuiltAfter = spans
      .filter((s) => s.type !== "removed")
      .map((s) => s.text)
      .join(" ");
    const rebuiltBefore = spans
      .filter((s) => s.type !== "added")
      .map((s) => s.text)
      .join(" ");
    expect(rebuiltAfter).toBe(after);
    expect(rebuiltBefore).toBe(before);
  });
});
