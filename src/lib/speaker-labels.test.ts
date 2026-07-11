import { describe, expect, it } from "vitest";
import { speakerColor, speakerName, speakerOrder } from "./speaker-labels";

describe("speakerOrder", () => {
  it("returns distinct labels in order of first appearance", () => {
    const segments = [
      { speaker: 3 },
      { speaker: 0 },
      { speaker: 3 },
      { speaker: 1 },
      { speaker: 0 },
    ];
    expect(speakerOrder(segments)).toEqual([3, 0, 1]);
  });

  it("handles non-contiguous labels from the engine", () => {
    // Observed: requesting 4 clusters can emit labels {0, 1, 3} with no 2.
    expect(speakerOrder([{ speaker: 0 }, { speaker: 1 }, { speaker: 3 }])).toEqual([0, 1, 3]);
  });

  it("is empty for no segments", () => {
    expect(speakerOrder([])).toEqual([]);
  });
});

describe("speakerName", () => {
  it("letters speakers A, B, C…", () => {
    expect(speakerName(0)).toBe("Speaker A");
    expect(speakerName(1)).toBe("Speaker B");
    expect(speakerName(25)).toBe("Speaker Z");
  });

  it("rolls over past Z", () => {
    expect(speakerName(26)).toBe("Speaker AA");
    expect(speakerName(27)).toBe("Speaker AB");
  });
});

describe("speakerColor", () => {
  it("cycles through the five chart tokens", () => {
    expect(speakerColor(0)).toBe("var(--chart-1)");
    expect(speakerColor(4)).toBe("var(--chart-5)");
    expect(speakerColor(5)).toBe("var(--chart-1)");
  });
});
