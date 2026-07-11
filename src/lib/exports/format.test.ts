import { describe, expect, it } from "vitest";
import type { Session, Transcript } from "@/lib/schemas/session";
import {
  formatJson,
  formatMarkdown,
  formatSrt,
  msToClock,
  msToSrtTime,
} from "@/lib/exports/format";

const session: Session = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Team sync",
  createdAt: "2026-07-10T14:30:00.000Z",
  mode: "live",
  audioRetained: true,
  engineId: "whisper-local",
  speakers: [
    { label: "A", name: "Alice" },
    { label: "B" },
  ],
  status: "complete",
  durationMs: 65_000,
};

const transcript: Transcript = [
  {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    speakerLabel: "A",
    text: "Hello there.",
    startMs: 0,
    endMs: 2_500,
  },
  {
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    speakerLabel: "B",
    text: "General Kenobi.",
    startMs: 2_500,
    endMs: 5_000,
    confidence: 0.9,
  },
];

const nameFor = (label: string) => (label === "A" ? "Alice" : `Speaker ${label}`);

describe("time formatting", () => {
  it("formats SRT timestamps with milliseconds", () => {
    expect(msToSrtTime(0)).toBe("00:00:00,000");
    expect(msToSrtTime(2_500)).toBe("00:00:02,500");
    expect(msToSrtTime(3_661_007)).toBe("01:01:01,007");
    expect(msToSrtTime(-50)).toBe("00:00:00,000");
  });

  it("formats compact clocks", () => {
    expect(msToClock(65_000)).toBe("1:05");
    expect(msToClock(3_725_000)).toBe("1:02:05");
    expect(msToClock(0)).toBe("0:00");
  });
});

describe("formatMarkdown", () => {
  it("labels speakers and includes metadata", () => {
    const md = formatMarkdown(session, transcript, nameFor);
    expect(md).toContain("# Team sync");
    expect(md).toContain("whisper-local");
    expect(md).toContain("**Alice** (0:00)");
    expect(md).toContain("Hello there.");
    expect(md).toContain("**Speaker B** (0:02)");
  });

  it("handles an empty transcript", () => {
    const md = formatMarkdown(session, [], nameFor);
    expect(md).toContain("_(no speech)_");
  });
});

describe("formatSrt", () => {
  it("emits numbered cues with proper timing", () => {
    const srt = formatSrt(transcript, nameFor);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:02,500\nAlice: Hello there.");
    expect(srt).toContain("2\n00:00:02,500 --> 00:00:05,000\nSpeaker B: General Kenobi.");
  });

  it("guards zero-length cues", () => {
    const srt = formatSrt(
      [{ id: "x", speakerLabel: "A", text: "hi", startMs: 1000, endMs: 1000 }],
      nameFor,
    );
    expect(srt).toContain("00:00:01,000 --> 00:00:01,001");
  });
});

describe("formatJson", () => {
  it("round-trips to structured data with resolved names", () => {
    const parsed = JSON.parse(formatJson(session, transcript, nameFor));
    expect(parsed.title).toBe("Team sync");
    expect(parsed.speakers[0]).toMatchObject({ label: "A", name: "Alice" });
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[1]).toMatchObject({
      speaker: "Speaker B",
      confidence: 0.9,
      startMs: 2_500,
    });
  });
});
