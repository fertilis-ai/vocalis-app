import { describe, expect, it } from "vitest";
import { stripMarkdownForSpeech } from "./strip-markdown-for-speech";

describe("stripMarkdownForSpeech", () => {
  it("drops fenced code blocks entirely", () => {
    const input = "Before\n\n```ts\nconst x = 1;\n```\n\nAfter";
    expect(stripMarkdownForSpeech(input)).toBe("Before\n\nAfter");
  });

  it("replaces images with their alt text", () => {
    expect(stripMarkdownForSpeech("![a chart](chart.png)")).toBe("a chart");
  });

  it("replaces links with their link text", () => {
    expect(stripMarkdownForSpeech("See [the docs](https://example.com) for more")).toBe(
      "See the docs for more",
    );
  });

  it("unwraps inline code", () => {
    expect(stripMarkdownForSpeech("Run `bun install` first")).toBe("Run bun install first");
  });

  it("strips heading markers", () => {
    expect(stripMarkdownForSpeech("## Section title")).toBe("Section title");
  });

  it("strips blockquote and list markers", () => {
    expect(stripMarkdownForSpeech("> quoted line\n- item one\n- item two")).toBe(
      "quoted line\nitem one\nitem two",
    );
  });

  it("strips horizontal rules", () => {
    expect(stripMarkdownForSpeech("above\n\n---\n\nbelow")).toBe("above\n\nbelow");
  });

  it("unwraps bold and italic markers", () => {
    expect(stripMarkdownForSpeech("This is **bold** and _italic_ text")).toBe(
      "This is bold and italic text",
    );
  });

  it("collapses runs of blank lines", () => {
    expect(stripMarkdownForSpeech("a\n\n\n\nb")).toBe("a\n\nb");
  });
});
