import { ChevronDown, Star } from "lucide-react";
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
import { buildVoiceGroups, voiceStorageId } from "@/lib/engines/tts-voices";
import { useModelsStore } from "@/stores/models-store";
import { usePeopleStore } from "@/stores/people-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useVoicesStore } from "@/stores/voices-store";

// Per-conversation voice picker (spec §2.2A / M4.md item 4, brought forward
// per rec.md §4.4). Reuses the same voice catalog as the TTS playground bench
// (`buildVoiceGroups`) rather than duplicating the local/API/clone voice
// tables. Cloud groups (including ElevenLabs clone voices) are omitted
// entirely under privacy mode by `buildVoiceGroups` itself — no separate
// disabled-reason UI is needed here, unlike ModelPicker. Favorites float to
// the top of each group (M5 item 4).

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
  const people = usePeopleStore((s) => s.people);
  const loadPeople = usePeopleStore((s) => s.loadAll);
  const library = useVoicesStore((s) => s.voices);
  const loadLibrary = useVoicesStore((s) => s.load);

  useEffect(() => {
    if (!installedScanned) void loadInstalled();
    void loadPeople();
    void loadLibrary();
  }, [installedScanned, loadInstalled, loadPeople, loadLibrary]);

  const groups = useMemo(
    () =>
      buildVoiceGroups(installed, apiKeys, privacyMode, {
        people: Object.values(people),
        library,
      }),
    [installed, apiKeys, privacyMode, people, library],
  );

  const selected = useMemo(() => {
    if (value === undefined) return null;
    for (const group of groups) {
      const voice = group.voices.find((v) => voiceStorageId(v) === value);
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
                onClick={() => onChange(voiceStorageId(voice))}
              >
                <span className="flex-1 truncate">{voice.label}</span>
                {voice.favorite && (
                  <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
