import { describe, expect, it } from "vitest";
import type { ClipQuality } from "@/lib/engines/local";
import {
  cloneRefAdvice,
  cloneRefPasses,
  evaluateCloneRef,
} from "./clip-quality";

/** A healthy ~20 s take: clear speech, low noise floor, no clipping. */
function goodTake(overrides: Partial<ClipQuality> = {}): ClipQuality {
  return {
    durationSecs: 20,
    peak: 0.6,
    rms: 0.06,
    speechRms: 0.08,
    noiseRms: 0.005,
    speechSecs: 16,
    ...overrides,
  };
}

describe("evaluateCloneRef", () => {
  it("passes a clean take on all four checks", () => {
    const checks = evaluateCloneRef(goodTake());
    expect(checks).toHaveLength(4);
    expect(checks.every((c) => c.pass)).toBe(true);
    expect(cloneRefPasses(goodTake())).toBe(true);
    expect(cloneRefAdvice(checks)).toBeNull();
  });

  it("rejects clipping at or above 0.99 peak", () => {
    expect(cloneRefPasses(goodTake({ peak: 0.99 }))).toBe(false);
    expect(cloneRefPasses(goodTake({ peak: 1.0 }))).toBe(false);
    expect(cloneRefPasses(goodTake({ peak: 0.98 }))).toBe(true);
    const checks = evaluateCloneRef(goodTake({ peak: 1.0 }));
    expect(checks.find((c) => c.code === "clipping")?.pass).toBe(false);
    expect(cloneRefAdvice(checks)).toMatch(/clipped/);
  });

  it("rejects speech below the level floor", () => {
    const quiet = goodTake({ speechRms: 0.01 });
    expect(cloneRefPasses(quiet)).toBe(false);
    expect(cloneRefAdvice(evaluateCloneRef(quiet))).toMatch(/quiet/i);
  });

  it("rejects a noise floor above the ceiling", () => {
    const noisy = goodTake({ noiseRms: 0.05 });
    expect(cloneRefPasses(noisy)).toBe(false);
    expect(cloneRefAdvice(evaluateCloneRef(noisy))).toMatch(/noise/i);
  });

  it("does not fail noise when the VAD found no silence to measure", () => {
    // Wall-to-wall speech: noiseRms is 0 (no silence samples).
    expect(cloneRefPasses(goodTake({ noiseRms: 0 }))).toBe(true);
  });

  it("rejects takes outside the duration bounds or with too little speech", () => {
    expect(cloneRefPasses(goodTake({ durationSecs: 5, speechSecs: 4 }))).toBe(false);
    expect(cloneRefPasses(goodTake({ durationSecs: 120, speechSecs: 100 }))).toBe(false);
    expect(cloneRefPasses(goodTake({ speechSecs: 2 }))).toBe(false);
    // 10–60 s guided range passes comfortably.
    expect(cloneRefPasses(goodTake({ durationSecs: 12, speechSecs: 10 }))).toBe(true);
    expect(cloneRefPasses(goodTake({ durationSecs: 60, speechSecs: 50 }))).toBe(true);
  });

  it("reports the advice for the first failing check", () => {
    const bad = goodTake({ peak: 1.0, noiseRms: 0.05 });
    // Clipping is listed first, so its advice wins.
    expect(cloneRefAdvice(evaluateCloneRef(bad))).toMatch(/clipped/);
  });
});
