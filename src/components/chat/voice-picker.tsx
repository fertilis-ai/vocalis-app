import { ChevronDown } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { buildVoiceGroups, type PickerVoice } from "@/lib/engines/tts-voices";
import { useModelsStore } from "@/stores/models-store";
import { useSettingsStore } from "@/stores/settings-store";

// Per-conversation voice picker (spec §2.2A / M4.md item 4, brought forward
// per rec.md §4.4 as a small standalone follow-up). Reuses the same voice
// catalog as the TTS playground bench (`buildVoiceGroups`, the sole other
// consumer) rather than duplicating the local/API voice tables. Cloud groups
// are omitted entirely under privacy mode by `buildVoiceGroups` itself — no
// separate disabled-reason UI is needed here, unlike ModelPicker.

/** The storage form of a picked voice: local sid as a string, API voice id
 * as-is — matches what `message-playback.ts`'s `voiceId` param expects. */
function storageId(voice: PickerVoice): string {
  return voice.target.kind === "local" ? String(voice.target.sid) : voice.target.voice;
}

interface VoicePickerProps {
  value?: string;
  onChange: (voiceId: string) => void;
}

export function VoicePicker({ value, onChange }: VoicePickerProps) {
  const installed = useModelsStore((s) => s.installed);
  const installedScanned = useModelsStore((s) => s.installedScanned);
  const loadInstalled = useModelsStore((s) => s.loadInstalled);
  const apiKeys = useSettingsStore((s) => s.apiKeys);
  const privacyMode = useSettingsStore((s) => s.privacyMode);

  useEffect(() => {
    if (!installedScanned) void loadInstalled();
  }, [installedScanned, loadInstalled]);

  const groups = useMemo(
    () => buildVoiceGroups(installed, apiKeys, privacyMode),
    [installed, apiKeys, privacyMode],
  );

  const selected = useMemo(() => {
    if (value === undefined) return null;
    for (const group of groups) {
      const voice = group.voices.find((v) => storageId(v) === value);
      if (voice) return voice;
    }
    return null;
  }, [groups, value]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        <span className="max-w-40 truncate">{selected ? selected.label : "Default voice"}</span>
        <ChevronDown className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {groups.length === 0 && (
          <DropdownMenuItem disabled>No voices installed</DropdownMenuItem>
        )}
        {groups.map((group) => (
          <DropdownMenuGroup key={group.id}>
            <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
            {group.voices.map((voice) => (
              <DropdownMenuItem
                key={voice.key}
                onClick={() => onChange(storageId(voice))}
              >
                <span className="flex-1 truncate">{voice.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
