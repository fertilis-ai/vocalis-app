import { Palette } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { HUE_PRESETS } from "@/lib/hue-presets";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { SettingsSection } from "./settings-section";

const THEMES = ["light", "dark", "system"] as const;

export function AppearanceSettings() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const hue = useSettingsStore((s) => s.hue);
  const setHue = useSettingsStore((s) => s.setHue);
  const swatchMode = resolvedTheme === "dark" ? "dark" : "light";

  return (
    <SettingsSection icon={Palette} id="appearance" title="Appearance">
      <div className="space-y-6">
        <div>
          <span className="font-medium text-sm">Theme</span>
          <div className="mt-2 flex gap-2">
            {THEMES.map((value) => (
              <Button
                className="capitalize"
                key={value}
                onClick={() => setTheme(value)}
                variant={theme === value ? "secondary" : "outline"}
              >
                {value}
              </Button>
            ))}
          </div>
        </div>
        <div>
          <span className="font-medium text-sm">Accent hue</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {HUE_PRESETS.map((preset) => (
              <button
                aria-label={preset.label}
                className={cn(
                  "h-7 w-7 rounded-full border-2 transition-transform hover:scale-110",
                  hue === preset.id ? "border-foreground" : "border-transparent",
                )}
                key={preset.id}
                onClick={() => setHue(preset.id)}
                style={{ backgroundColor: preset.swatch[swatchMode] }}
                title={preset.label}
                type="button"
              />
            ))}
          </div>
          <p className="mt-2 text-muted-foreground text-xs">
            Tints the whole interface with an OKLCH hue rotation.
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}
