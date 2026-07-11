export type HueId =
  | "neutral"
  | "rose"
  | "orange"
  | "amber"
  | "lime"
  | "green"
  | "teal"
  | "cyan"
  | "blue"
  | "violet";

interface HuePreset {
  id: HueId;
  label: string;
  hue: number;
  swatch: { light: string; dark: string };
}

export const HUE_PRESETS: HuePreset[] = [
  { id: "neutral", label: "Neutral", hue: 0, swatch: { light: "#737373", dark: "#a3a3a3" } },
  { id: "rose", label: "Rose", hue: 12, swatch: { light: "#e11d48", dark: "#fb7185" } },
  { id: "orange", label: "Orange", hue: 55, swatch: { light: "#ea580c", dark: "#fb923c" } },
  { id: "amber", label: "Amber", hue: 85, swatch: { light: "#d97706", dark: "#fbbf24" } },
  { id: "lime", label: "Lime", hue: 130, swatch: { light: "#65a30d", dark: "#a3e635" } },
  { id: "green", label: "Green", hue: 155, swatch: { light: "#16a34a", dark: "#4ade80" } },
  { id: "teal", label: "Teal", hue: 180, swatch: { light: "#0d9488", dark: "#2dd4bf" } },
  { id: "cyan", label: "Cyan", hue: 210, swatch: { light: "#0891b2", dark: "#22d3ee" } },
  { id: "blue", label: "Blue", hue: 250, swatch: { light: "#2563eb", dark: "#60a5fa" } },
  { id: "violet", label: "Violet", hue: 290, swatch: { light: "#7c3aed", dark: "#a78bfa" } },
];

export function getHueCssOverrides(
  hueId: HueId,
  mode: "light" | "dark"
): Record<string, string> | null {
  if (hueId === "neutral") return null;

  const preset = HUE_PRESETS.find((p) => p.id === hueId);
  if (!preset) return null;

  const H = preset.hue;

  if (mode === "light") {
    return {
      "--background": `oklch(0.995 0.012 ${H})`,
      "--foreground": `oklch(0.145 0.02 ${H})`,
      "--card": `oklch(0.975 0.03 ${H})`,
      "--card-foreground": `oklch(0.145 0.02 ${H})`,
      "--popover": `oklch(1 0.01 ${H})`,
      "--popover-foreground": `oklch(0.145 0.02 ${H})`,
      "--primary": `oklch(0.45 0.2 ${H})`,
      "--primary-foreground": `oklch(0.985 0.02 ${H})`,
      "--secondary": `oklch(0.97 0.01 ${H})`,
      "--secondary-foreground": `oklch(0.205 0.04 ${H})`,
      "--muted": `oklch(0.97 0.01 ${H})`,
      "--muted-foreground": `oklch(0.556 0.02 ${H})`,
      "--accent": `oklch(0.95 0.025 ${H})`,
      "--accent-foreground": `oklch(0.30 0.08 ${H})`,
      "--border": `oklch(0.922 0.01 ${H})`,
      "--input": `oklch(0.922 0.01 ${H})`,
      "--ring": `oklch(0.60 0.12 ${H})`,
      "--sidebar": `oklch(0.985 0.01 ${H})`,
      "--sidebar-foreground": `oklch(0.145 0.02 ${H})`,
      "--sidebar-primary": `oklch(0.45 0.2 ${H})`,
      "--sidebar-primary-foreground": `oklch(0.985 0.02 ${H})`,
      "--sidebar-accent": `oklch(0.95 0.025 ${H})`,
      "--sidebar-accent-foreground": `oklch(0.205 0.04 ${H})`,
      "--sidebar-border": `oklch(0.922 0.01 ${H})`,
      "--sidebar-ring": `oklch(0.60 0.12 ${H})`,
      "--chart-1": `oklch(0.70 0.15 ${H})`,
      "--chart-2": `oklch(0.61 0.17 ${H})`,
      "--chart-3": `oklch(0.52 0.19 ${H})`,
      "--chart-4": `oklch(0.43 0.18 ${H})`,
      "--chart-5": `oklch(0.35 0.15 ${H})`,
    };
  }

  return {
    "--background": `oklch(0.145 0.02 ${H})`,
    "--foreground": `oklch(0.985 0.02 ${H})`,
    "--card": `oklch(0.21 0.035 ${H})`,
    "--card-foreground": `oklch(0.985 0.02 ${H})`,
    "--popover": `oklch(0.205 0.015 ${H})`,
    "--popover-foreground": `oklch(0.985 0.02 ${H})`,
    "--primary": `oklch(0.75 0.15 ${H})`,
    "--primary-foreground": `oklch(0.15 0.02 ${H})`,
    "--secondary": `oklch(0.269 0.015 ${H})`,
    "--secondary-foreground": `oklch(0.985 0.02 ${H})`,
    "--muted": `oklch(0.269 0.015 ${H})`,
    "--muted-foreground": `oklch(0.708 0.02 ${H})`,
    "--accent": `oklch(0.30 0.03 ${H})`,
    "--accent-foreground": `oklch(0.90 0.06 ${H})`,
    "--border": `oklch(1 0.03 ${H} / 10%)`,
    "--input": `oklch(1 0.03 ${H} / 15%)`,
    "--ring": `oklch(0.55 0.10 ${H})`,
    "--sidebar": `oklch(0.205 0.015 ${H})`,
    "--sidebar-foreground": `oklch(0.985 0.02 ${H})`,
    "--sidebar-primary": `oklch(0.75 0.15 ${H})`,
    "--sidebar-primary-foreground": `oklch(0.15 0.02 ${H})`,
    "--sidebar-accent": `oklch(0.28 0.03 ${H})`,
    "--sidebar-accent-foreground": `oklch(0.985 0.02 ${H})`,
    "--sidebar-border": `oklch(1 0.03 ${H} / 10%)`,
    "--sidebar-ring": `oklch(0.55 0.10 ${H})`,
    "--chart-1": `oklch(0.75 0.13 ${H})`,
    "--chart-2": `oklch(0.66 0.15 ${H})`,
    "--chart-3": `oklch(0.57 0.17 ${H})`,
    "--chart-4": `oklch(0.48 0.16 ${H})`,
    "--chart-5": `oklch(0.40 0.13 ${H})`,
  };
}

const HUE_MANAGED_PROPS = [
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

export function applyHueOverrides(overrides: Record<string, string>) {
  const el = document.documentElement;
  for (const [prop, value] of Object.entries(overrides)) {
    el.style.setProperty(prop, value);
  }
}

export function clearHueOverrides() {
  const el = document.documentElement;
  for (const prop of HUE_MANAGED_PROPS) {
    el.style.removeProperty(prop);
  }
}
