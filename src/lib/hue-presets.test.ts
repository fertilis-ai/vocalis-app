import { describe, it, expect, afterEach } from "vitest";
import {
  HUE_PRESETS,
  getHueCssOverrides,
  applyHueOverrides,
  clearHueOverrides,
  type HueId,
} from "./hue-presets";

describe("HUE_PRESETS", () => {
  it("is a non-empty array", () => {
    expect(HUE_PRESETS.length).toBeGreaterThan(0);
  });

  it("every preset has required fields with correct types", () => {
    for (const preset of HUE_PRESETS) {
      expect(typeof preset.id).toBe("string");
      expect(typeof preset.label).toBe("string");
      expect(typeof preset.hue).toBe("number");
      expect(typeof preset.swatch.light).toBe("string");
      expect(typeof preset.swatch.dark).toBe("string");
    }
  });

  it("has unique ids", () => {
    const ids = HUE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique labels", () => {
    const labels = HUE_PRESETS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("includes neutral preset", () => {
    const neutral = HUE_PRESETS.find((p) => p.id === "neutral");
    expect(neutral).toBeDefined();
    expect(neutral!.hue).toBe(0);
  });

  it("all hue values are non-negative numbers", () => {
    for (const preset of HUE_PRESETS) {
      expect(preset.hue).toBeGreaterThanOrEqual(0);
    }
  });

  it("swatch colors look like hex colors", () => {
    for (const preset of HUE_PRESETS) {
      expect(preset.swatch.light).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(preset.swatch.dark).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

describe("getHueCssOverrides", () => {
  it("returns null for neutral hue", () => {
    expect(getHueCssOverrides("neutral", "light")).toBeNull();
    expect(getHueCssOverrides("neutral", "dark")).toBeNull();
  });

  it("returns null for unknown hue id", () => {
    expect(getHueCssOverrides("nonexistent" as HueId, "light")).toBeNull();
  });

  it("returns CSS overrides object for valid non-neutral hue in light mode", () => {
    const overrides = getHueCssOverrides("blue", "light");
    expect(overrides).not.toBeNull();
    expect(overrides!["--background"]).toBeDefined();
    expect(overrides!["--foreground"]).toBeDefined();
    expect(overrides!["--primary"]).toBeDefined();
  });

  it("returns CSS overrides object for valid non-neutral hue in dark mode", () => {
    const overrides = getHueCssOverrides("blue", "dark");
    expect(overrides).not.toBeNull();
    expect(overrides!["--background"]).toBeDefined();
    expect(overrides!["--foreground"]).toBeDefined();
    expect(overrides!["--primary"]).toBeDefined();
  });

  it("light and dark overrides have the same keys", () => {
    const light = getHueCssOverrides("rose", "light")!;
    const dark = getHueCssOverrides("rose", "dark")!;
    const lightKeys = Object.keys(light).sort();
    const darkKeys = Object.keys(dark).sort();
    expect(lightKeys).toEqual(darkKeys);
  });

  it("light and dark overrides have different values", () => {
    const light = getHueCssOverrides("rose", "light")!;
    const dark = getHueCssOverrides("rose", "dark")!;
    // background should differ between light and dark
    expect(light["--background"]).not.toBe(dark["--background"]);
  });

  it("uses the correct hue value in overrides", () => {
    const bluePreset = HUE_PRESETS.find((p) => p.id === "blue")!;
    const overrides = getHueCssOverrides("blue", "light")!;
    // All oklch values should contain the preset's hue number
    expect(overrides["--background"]).toContain(String(bluePreset.hue));
    expect(overrides["--primary"]).toContain(String(bluePreset.hue));
  });

  it("works for every non-neutral preset in both modes", () => {
    for (const preset of HUE_PRESETS) {
      if (preset.id === "neutral") continue;
      const light = getHueCssOverrides(preset.id, "light");
      const dark = getHueCssOverrides(preset.id, "dark");
      expect(light).not.toBeNull();
      expect(dark).not.toBeNull();
    }
  });

  it("override values are oklch color strings", () => {
    const overrides = getHueCssOverrides("teal", "light")!;
    for (const value of Object.values(overrides)) {
      expect(value).toMatch(/^oklch\(/);
    }
  });
});

describe("applyHueOverrides", () => {
  afterEach(() => {
    // Clean up any properties we set
    clearHueOverrides();
  });

  it("sets CSS custom properties on document.documentElement", () => {
    const overrides = {
      "--background": "oklch(0.995 0.012 250)",
      "--foreground": "oklch(0.145 0.02 250)",
    };

    applyHueOverrides(overrides);

    expect(document.documentElement.style.getPropertyValue("--background")).toBe(
      "oklch(0.995 0.012 250)"
    );
    expect(document.documentElement.style.getPropertyValue("--foreground")).toBe(
      "oklch(0.145 0.02 250)"
    );
  });

  it("applies all properties from a full preset override", () => {
    const overrides = getHueCssOverrides("blue", "light")!;
    applyHueOverrides(overrides);

    for (const [prop, value] of Object.entries(overrides)) {
      expect(document.documentElement.style.getPropertyValue(prop)).toBe(value);
    }
  });

  it("overwrites previously applied overrides", () => {
    applyHueOverrides({ "--primary": "oklch(0.45 0.2 250)" });
    applyHueOverrides({ "--primary": "oklch(0.75 0.15 12)" });

    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      "oklch(0.75 0.15 12)"
    );
  });

  it("handles empty overrides object without error", () => {
    expect(() => applyHueOverrides({})).not.toThrow();
  });
});

describe("clearHueOverrides", () => {
  it("removes all managed CSS custom properties", () => {
    // First apply some overrides
    const overrides = getHueCssOverrides("rose", "dark")!;
    applyHueOverrides(overrides);

    // Verify at least one is set
    expect(document.documentElement.style.getPropertyValue("--background")).not.toBe("");

    // Clear
    clearHueOverrides();

    // Verify all managed properties are removed
    const managedProps = [
      "--background",
      "--foreground",
      "--card",
      "--card-foreground",
      "--popover",
      "--popover-foreground",
      "--primary",
      "--primary-foreground",
      "--secondary",
      "--secondary-foreground",
      "--muted",
      "--muted-foreground",
      "--accent",
      "--accent-foreground",
      "--border",
      "--input",
      "--ring",
      "--sidebar",
      "--sidebar-foreground",
      "--sidebar-primary",
      "--sidebar-primary-foreground",
      "--sidebar-accent",
      "--sidebar-accent-foreground",
      "--sidebar-border",
      "--sidebar-ring",
      "--chart-1",
      "--chart-2",
      "--chart-3",
      "--chart-4",
      "--chart-5",
    ];

    for (const prop of managedProps) {
      expect(document.documentElement.style.getPropertyValue(prop)).toBe("");
    }
  });

  it("does not throw when no overrides were applied", () => {
    expect(() => clearHueOverrides()).not.toThrow();
  });

  it("can be called multiple times safely", () => {
    clearHueOverrides();
    clearHueOverrides();
    // Should not throw
  });

  it("does not remove non-managed CSS properties", () => {
    // Set a non-managed property
    document.documentElement.style.setProperty("--custom-prop", "red");

    const overrides = getHueCssOverrides("blue", "light")!;
    applyHueOverrides(overrides);
    clearHueOverrides();

    // The custom property should still be there
    expect(document.documentElement.style.getPropertyValue("--custom-prop")).toBe("red");

    // Cleanup
    document.documentElement.style.removeProperty("--custom-prop");
  });
});
