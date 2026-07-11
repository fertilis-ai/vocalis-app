import { Check, ChevronDown, Mic } from "lucide-react";
import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type AudioInputDevice, listAudioInputDevices } from "@/lib/engines/local";
import { isDesktop } from "@/lib/storage";
import { useSettingsStore } from "@/stores/settings-store";
import { SettingsSection } from "./settings-section";

export function AudioSettings() {
  const inputDevice = useSettingsStore((s) => s.audioInputDevice);
  const setAudioInputDevice = useSettingsStore((s) => s.setAudioInputDevice);
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listAudioInputDevices()
      .then(setDevices)
      .catch((err) => setError(String(err)));
  }, []);

  const selected = devices.find((device) => device.name === inputDevice);
  const systemDefault = devices.find((device) => device.isDefault);
  const triggerLabel = inputDevice
    ? inputDevice
    : systemDefault
      ? `System default (${systemDefault.name})`
      : "System default";

  return (
    <SettingsSection icon={Mic} id="audio" title="Audio">
      <div className="space-y-4">
        <div>
          <span className="font-medium text-sm">Input device</span>
          <div className="mt-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                className="flex w-full max-w-md items-center gap-2 rounded-md border border-input px-3 py-1.5 text-sm transition-colors hover:bg-accent disabled:opacity-50"
                disabled={!isDesktop()}
              >
                <span className="flex-1 truncate text-left">{triggerLabel}</span>
                {selected && (
                  <span className="text-muted-foreground text-xs">
                    {(selected.sampleRate / 1000).toFixed(1)} kHz
                  </span>
                )}
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-96">
                <DropdownMenuItem onClick={() => setAudioInputDevice("")}>
                  <span className="flex-1">System default</span>
                  {!inputDevice && <Check className="h-3.5 w-3.5" />}
                </DropdownMenuItem>
                {devices.map((device) => (
                  <DropdownMenuItem
                    key={device.name}
                    onClick={() => setAudioInputDevice(device.name)}
                  >
                    <span className="flex-1 truncate">
                      {device.name}
                      {device.isDefault && (
                        <span className="ml-1 text-muted-foreground text-xs">default</span>
                      )}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {(device.sampleRate / 1000).toFixed(1)} kHz
                    </span>
                    {inputDevice === device.name && <Check className="h-3.5 w-3.5" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <p className="mt-2 text-muted-foreground text-xs">
            Applies to new recordings — capture is resampled to 16 kHz mono for the
            speech engines. A selected device that disappears falls back to the system
            default.
          </p>
        </div>
        {!isDesktop() && (
          <p className="text-muted-foreground text-sm">
            Device selection requires the desktop app.
          </p>
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}
      </div>
    </SettingsSection>
  );
}
