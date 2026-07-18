import * as React from "react";
import { Cloud, Loader2, Play, Star, User, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  buildVoiceGroups,
  cloneLibraryVoices,
  type PickerVoice,
  previewSentence,
  toLibraryVoice,
} from "@/lib/engines/tts-voices";
import { audioUrl } from "@/lib/engines/local";
import { synthesizeWithTarget } from "@/lib/engines/port";
import { cn } from "@/lib/utils";
import { useModelsStore } from "@/stores/models-store";
import { usePeopleStore } from "@/stores/people-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useVoicesStore } from "@/stores/voices-store";

// The TTS voice library (spec §2.4, M5 item 4): everything speakable in one
// list — stock local voices, provider voices, clone voices from People —
// with kind badges, a favorite star (floats the voice to the top of every
// picker), a per-voice default speed, and a preview button speaking a fixed
// sample sentence per voice language.

/** Default-speed choices; undefined = the engine's own default (1×). */
const SPEED_CHOICES = [0.8, 0.9, 1, 1.1, 1.25, 1.5];

export function VoiceLibrary() {
  const installed = useModelsStore((s) => s.installed);
  const installedScanned = useModelsStore((s) => s.installedScanned);
  const loadInstalled = useModelsStore((s) => s.loadInstalled);
  const apiKeys = useSettingsStore((s) => s.apiKeys);
  const privacyMode = useSettingsStore((s) => s.privacyMode);
  const people = usePeopleStore((s) => s.people);
  const loadPeople = usePeopleStore((s) => s.loadAll);
  const library = useVoicesStore((s) => s.voices);
  const loadLibrary = useVoicesStore((s) => s.load);
  const syncClones = useVoicesStore((s) => s.syncClones);

  React.useEffect(() => {
    if (!installedScanned) void loadInstalled();
    void loadPeople();
    void loadLibrary();
  }, [installedScanned, loadInstalled, loadPeople, loadLibrary]);

  // Keep the persisted library's clone entries mirroring People (M5 item 4:
  // clone voices are derived state; favorites/speed on them survive).
  const peopleList = React.useMemo(() => Object.values(people), [people]);
  React.useEffect(() => {
    void syncClones(cloneLibraryVoices(peopleList));
  }, [peopleList, syncClones]);

  const groups = React.useMemo(
    () =>
      buildVoiceGroups(installed, apiKeys, privacyMode, {
        people: peopleList,
        library,
      }),
    [installed, apiKeys, privacyMode, peopleList, library],
  );

  if (groups.length === 0) {
    return (
      <div className="mx-auto max-w-2xl p-6 text-muted-foreground text-sm">
        No voices yet — download a TTS model in Models, add an API key in
        Settings, or record a voice clone under People.
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div>
        <h1 className="font-semibold text-xl">Voice library</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Every voice the app can speak with. Favorites float to the top of
          voice pickers; the default speed applies wherever the voice is used.
        </p>
      </div>
      {groups.map((group) => (
        <section key={group.id}>
          <h2 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {group.label}
          </h2>
          <div className="flex flex-col divide-y divide-border rounded-md border border-border">
            {group.voices.map((voice) => (
              <VoiceRow key={voice.key} voice={voice} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function VoiceRow({ voice }: { voice: PickerVoice }) {
  const apiKeys = useSettingsStore((s) => s.apiKeys);
  const people = usePeopleStore((s) => s.people);
  const toggleFavorite = useVoicesStore((s) => s.toggleFavorite);
  const setDefaultSpeed = useVoicesStore((s) => s.setDefaultSpeed);
  const [previewing, setPreviewing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  React.useEffect(() => {
    return () => audioRef.current?.pause();
  }, []);

  async function preview() {
    setPreviewing(true);
    setError(null);
    try {
      const res = await synthesizeWithTarget(
        voice.target,
        previewSentence(voice.lang),
        { apiKeys, speed: voice.defaultSpeed },
      );
      audioRef.current?.pause();
      const el = new Audio(audioUrl(res.path));
      audioRef.current = el;
      await el.play();
    } catch (err) {
      setError(String(err));
    } finally {
      setPreviewing(false);
    }
  }

  const person = voice.personId ? people[voice.personId] : undefined;

  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-6 w-6"
          aria-label={voice.favorite ? "Unfavorite" : "Favorite"}
          onClick={() => void toggleFavorite(toLibraryVoice(voice))}
        >
          <Star
            className={cn(
              "h-3.5 w-3.5",
              voice.favorite
                ? "fill-amber-400 text-amber-400"
                : "text-muted-foreground",
            )}
          />
        </Button>

        <span className="flex-1 truncate text-sm">{voice.label}</span>

        {voice.kind === "clone" && person && (
          <Badge>
            <User className="h-3 w-3" /> {person.name}
          </Badge>
        )}
        {voice.target.kind === "local" || voice.target.kind === "clone-local" ? (
          <Badge>
            <Zap className="h-3 w-3" /> local
          </Badge>
        ) : (
          <Badge>
            <Cloud className="h-3 w-3" /> cloud
          </Badge>
        )}
        {voice.lang && <Badge>{voice.lang}</Badge>}

        <select
          value={voice.defaultSpeed ?? ""}
          onChange={(e) =>
            void setDefaultSpeed(
              toLibraryVoice(voice),
              e.target.value === "" ? undefined : Number(e.target.value),
            )
          }
          className="h-6 rounded border border-border bg-background px-1 text-xs"
          aria-label="Default speed"
        >
          <option value="">1×</option>
          {SPEED_CHOICES.filter((s) => s !== 1).map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>

        <Button
          variant="ghost"
          size="icon-xs"
          className="h-6 w-6"
          aria-label="Preview voice"
          disabled={previewing}
          onClick={() => void preview()}
        >
          {previewing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex flex-shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}
