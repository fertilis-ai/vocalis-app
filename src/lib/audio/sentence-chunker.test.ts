import { describe, expect, it } from "vitest";
import { createSentenceChunker } from "./sentence-chunker";

describe("createSentenceChunker", () => {
  it("emits a sentence once its terminator and trailing space arrive", () => {
    const chunker = createSentenceChunker();
    expect(chunker.push("Hello there")).toEqual([]);
    expect(chunker.push(". General Kenobi")).toEqual(["Hello there."]);
    expect(chunker.flush()).toEqual(["General Kenobi"]);
  });

  it("emits multiple sentences delivered in a single delta", () => {
    const chunker = createSentenceChunker();
    expect(chunker.push("First one. Second one. Third ")).toEqual([
      "First one.",
      "Second one.",
    ]);
    expect(chunker.flush()).toEqual(["Third"]);
  });

  it("splits on ! and ? and on runs of terminal punctuation", () => {
    const chunker = createSentenceChunker();
    expect(chunker.push("Wait! Really? No way... ")).toEqual([
      "Wait!",
      "Really?",
      "No way...",
    ]);
  });

  it("does not split on a title abbreviation", () => {
    const chunker = createSentenceChunker();
    expect(chunker.push("I saw Dr. Smith yesterday. He waved.")).toEqual([
      "I saw Dr. Smith yesterday.",
    ]);
  });

  it("does not split on common abbreviations mid-sentence", () => {
    const chunker = createSentenceChunker();
    const out = chunker.push(
      "Bring snacks, e.g. chips, drinks, etc. for the trip. Pack tonight.",
    );
    expect(out).toEqual(["Bring snacks, e.g. chips, drinks, etc. for the trip."]);
  });

  it("does not split on a decimal point", () => {
    const chunker = createSentenceChunker();
    const out = chunker.push("Pi is about 3.14159 and it never repeats. Neat huh?");
    expect(out).toEqual(["Pi is about 3.14159 and it never repeats."]);
  });

  it("splits correctly after a number that isn't a decimal", () => {
    const chunker = createSentenceChunker();
    const out = chunker.push("The price is $5. It went up yesterday. ");
    expect(out).toEqual(["The price is $5.", "It went up yesterday."]);
  });

  it("waits for more text when a boundary could still extend", () => {
    const chunker = createSentenceChunker();
    // "3." could become "3.14" with the next delta — must not emit early.
    expect(chunker.push("The value is 3")).toEqual([]);
    expect(chunker.push(".")).toEqual([]);
    expect(chunker.push("14 exactly. Done.")).toEqual(["The value is 3.14 exactly."]);
  });

  it("drops fenced code blocks entirely and keeps surrounding prose", () => {
    const chunker = createSentenceChunker();
    const out = chunker.push(
      "Here is the fix.\n```js\nconst x = 1.5; // not spoken.\n```\nThat should do it. Thanks.",
    );
    expect(out).toEqual(["Here is the fix.", "That should do it."]);
    expect(chunker.flush().join(" ")).not.toMatch(/const x|not spoken/);
  });

  it("handles a code fence split across two deltas", () => {
    const chunker = createSentenceChunker();
    const out = [
      ...chunker.push("Try this.\n``"),
      ...chunker.push("`py\nprint(1.5)\n``"),
      ...chunker.push("`\nDone here. Bye."),
    ];
    expect(out.join(" ")).not.toMatch(/print/);
    expect(out).toEqual(["Try this.", "Done here."]);
  });

  it("discards an unterminated code block on flush", () => {
    const chunker = createSentenceChunker();
    chunker.push("Before.\n```js\nconst unterminated = true;\n");
    expect(chunker.flush()).toEqual([]);
  });

  it("flush returns remaining buffered text as a final sentence with no terminator", () => {
    const chunker = createSentenceChunker();
    chunker.push("This trails off without punctuation");
    expect(chunker.flush()).toEqual(["This trails off without punctuation"]);
  });

  it("flush is a no-op when nothing is buffered", () => {
    const chunker = createSentenceChunker();
    chunker.push("Complete sentence. ");
    chunker.flush();
    expect(chunker.flush()).toEqual([]);
  });
});
