import { describe, expect, it } from "vitest";
import { autoTitle } from "./chat-title";

describe("autoTitle", () => {
  it("returns short text unchanged", () => {
    expect(autoTitle("Hey there")).toBe("Hey there");
  });

  it("collapses internal whitespace and newlines", () => {
    expect(autoTitle("Hey  \n there   friend")).toBe("Hey there friend");
  });

  it("trims leading/trailing whitespace", () => {
    expect(autoTitle("  hello  ")).toBe("hello");
  });

  it("truncates long text with an ellipsis at maxLength", () => {
    const long = "a".repeat(100);
    const title = autoTitle(long);
    expect(title.length).toBe(48);
    expect(title.endsWith("…")).toBe(true);
  });

  it("respects a custom maxLength", () => {
    const title = autoTitle("abcdefghij", 5);
    expect(title).toBe("abcd…");
  });
});
