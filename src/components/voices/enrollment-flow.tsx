import * as React from "react";
import { Check, Circle, Loader2, RotateCcw, Square } from "lucide-react";
import { LevelMeter } from "@/components/bench/level-meter";
import { Button } from "@/components/ui/button";
import {
  cancelRecording,
  enrollPerson,
  type RecorderEvent,
  startEnrollmentRecording,
  stopRecording,
} from "@/lib/engines/local";
import type { Person } from "@/lib/schemas/people";
import { isDesktop } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { usePeopleStore } from "@/stores/people-store";

// Guided ~30 s enrollment (spec §3.5, M3 item 3): a few scripted prompt cards,
// each recording one clip via the bench recorder. On save, Rust embeds every
// clip and averages them into people/<id>/embedding.bin.

interface Prompt {
  slot: number;
  heading: string;
  text: string;
}

const PROMPTS: Prompt[] = [
  {
    slot: 0,
    heading: "Read this aloud",
    text: "The quick brown fox jumps over the lazy dog while the sun sets behind the distant hills.",
  },
  {
    slot: 1,
    heading: "Read this aloud",
    text: "Recording a clear sample now helps the app recognize my voice during meetings later on.",
  },
  {
    slot: 2,
    heading: "Speak freely for about ten seconds",
    text: "Talk about your day, a project you're working on, or anything on your mind.",
  },
];

/** The minimum clips before enrollment can be saved (spec targets ~30 s total). */
const MIN_CLIPS = 2;

interface RecordedClip {
  path: string;
  durationMs: number;
}

export function EnrollmentFlow({ person }: { person: Person }) {
  const saveEnrollment = usePeopleStore((s) => s.saveEnrollment);
  // Recorded clips keyed by prompt slot.
  const [clips, setClips] = React.useState<Record<number, RecordedClip>>({});
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const recorded = Object.keys(clips).length;
  const canSave = recorded >= MIN_CLIPS && !saving;

  const onRecorded = React.useCallback((slot: number, clip: RecordedClip) => {
    setError(null);
    setClips((prev) => ({ ...prev, [slot]: clip }));
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const slots = Object.keys(clips)
        .map(Number)
        .sort((a, b) => a - b);
      const result = await enrollPerson(
        person.id,
        slots.map((slot) => clips[slot].path),
      );
      await saveEnrollment(person.id, {
        samples: slots.map((slot) => ({
          path: `enrollment/clip-${slot}.wav`,
          durationMs: clips[slot].durationMs,
        })),
        embeddingPath: result.embeddingPath,
        embeddingDim: result.embeddingDim,
        enrolledAt: new Date().toISOString(),
      });
      setClips({});
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!isDesktop()) {
    return (
      <p className="text-muted-foreground text-sm">
        Enrollment requires the desktop app.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        Record at least {MIN_CLIPS} short clips. Speak naturally, in a quiet
        space — the samples are averaged into one voiceprint.
      </p>

      {PROMPTS.map((prompt) => (
        <PromptCard
          key={prompt.slot}
          personId={person.id}
          prompt={prompt}
          clip={clips[prompt.slot] ?? null}
          onRecorded={onRecorded}
        />
      ))}

      {error && <p className="text-destructive text-xs">{error}</p>}

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={!canSave}>
          {saving ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Check className="mr-1 h-4 w-4" />
          )}
          {person.enrollment ? "Re-enroll voice" : "Save enrollment"}
        </Button>
        <span className="text-muted-foreground text-xs">
          {recorded} of {PROMPTS.length} recorded
          {recorded < MIN_CLIPS && ` — ${MIN_CLIPS - recorded} more to save`}
        </span>
      </div>
    </div>
  );
}

function PromptCard({
  personId,
  prompt,
  clip,
  onRecorded,
}: {
  personId: string;
  prompt: Prompt;
  clip: RecordedClip | null;
  onRecorded: (slot: number, clip: RecordedClip) => void;
}) {
  const [recorderId, setRecorderId] = React.useState<number | null>(null);
  const [level, setLevel] = React.useState({ rms: 0, peak: 0 });
  const [error, setError] = React.useState<string | null>(null);
  const recorderRef = React.useRef<number | null>(null);

  // A recording left running when the flow unmounts is discarded.
  React.useEffect(() => {
    return () => {
      if (recorderRef.current !== null) void cancelRecording(recorderRef.current);
    };
  }, []);

  const reset = React.useCallback(() => {
    recorderRef.current = null;
    setRecorderId(null);
    setLevel({ rms: 0, peak: 0 });
  }, []);

  const handleEvent = React.useCallback(
    (event: RecorderEvent) => {
      switch (event.type) {
        case "level":
          setLevel({ rms: event.rms, peak: event.peak });
          break;
        case "saved":
          reset();
          onRecorded(prompt.slot, {
            path: event.path,
            durationMs: Math.round(event.durationSecs * 1000),
          });
          break;
        case "cancelled":
          reset();
          break;
        case "error":
          reset();
          setError(event.message);
          break;
      }
    },
    [onRecorded, prompt.slot, reset],
  );

  const record = React.useCallback(async () => {
    setError(null);
    try {
      const id = await startEnrollmentRecording(personId, prompt.slot, handleEvent);
      recorderRef.current = id;
      setRecorderId(id);
    } catch (err) {
      setError(String(err));
    }
  }, [handleEvent, personId, prompt.slot]);

  const recording = recorderId !== null;

  return (
    <div
      className={cn(
        "rounded-md border border-border p-3",
        clip && "border-emerald-500/40 bg-emerald-500/5",
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
          {prompt.heading}
        </span>
        {clip && !recording && (
          <span className="flex items-center gap-1 text-emerald-600 text-xs dark:text-emerald-400">
            <Check className="h-3.5 w-3.5" />
            {(clip.durationMs / 1000).toFixed(1)} s
          </span>
        )}
      </div>
      <p className="mb-3 text-sm">{prompt.text}</p>

      <div className="flex items-center gap-3">
        {recording ? (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => recorderId !== null && stopRecording(recorderId)}
          >
            <Square className="mr-1 h-4 w-4" /> Stop
          </Button>
        ) : clip ? (
          <Button size="sm" variant="outline" onClick={() => void record()}>
            <RotateCcw className="mr-1 h-4 w-4" /> Re-record
          </Button>
        ) : (
          <Button size="sm" onClick={() => void record()}>
            <Circle className="mr-1 h-3 w-3 fill-destructive text-destructive" />
            Record
          </Button>
        )}
        {recording && <LevelMeter rms={level.rms} peak={level.peak} />}
      </div>
      {error && <p className="mt-2 text-destructive text-xs">{error}</p>}
    </div>
  );
}
