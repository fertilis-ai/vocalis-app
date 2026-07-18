import * as React from "react";
import { Check, Circle, Loader2, Play, RotateCcw, Square, X } from "lucide-react";
import { LevelMeter } from "@/components/bench/level-meter";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  cloneRefAdvice,
  evaluateCloneRef,
  type QualityCheck,
} from "@/lib/audio/clip-quality";
import {
  asrTranscribeFile,
  audioUrl,
  cancelRecording,
  cloneRefQuality,
  type RecorderEvent,
  startCloneRefRecording,
  stopRecording,
} from "@/lib/engines/local";
import type { Person } from "@/lib/schemas/people";
import { isDesktop } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { usePeopleStore } from "@/stores/people-store";

// Guided clone-reference recording (spec §2.4, M5 item 1): one clean 10–60 s
// take through the bench recorder, gated by quality checks (clipping / level /
// noise / length — thresholds in lib/audio/clip-quality.ts), then transcribed
// locally so the user can correct the text ZipVoice conditions on. Saving
// requires the consent confirmation — the schema itself refuses cloneRef
// without `consentConfirmed: true`, so this is not skippable in code paths.

const REF_SLOT = 0;
const REF_PATH = `clone-ref/clip-${REF_SLOT}.wav`;

type Phase =
  | { step: "idle" }
  | { step: "recording"; recorderId: number }
  | { step: "checking"; path: string }
  | {
      step: "review";
      path: string;
      durationMs: number;
      checks: QualityCheck[];
      passed: boolean;
    };

export function CloneRefFlow({ person }: { person: Person }) {
  const update = usePeopleStore((s) => s.update);
  const [phase, setPhase] = React.useState<Phase>({ step: "idle" });
  const [level, setLevel] = React.useState({ rms: 0, peak: 0 });
  const [transcript, setTranscript] = React.useState("");
  const [transcribing, setTranscribing] = React.useState(false);
  const [consent, setConsent] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const recorderRef = React.useRef<number | null>(null);

  // A recording left running when the view unmounts is discarded.
  React.useEffect(() => {
    return () => {
      if (recorderRef.current !== null) void cancelRecording(recorderRef.current);
    };
  }, []);

  const analyze = React.useCallback(async (path: string, durationMs: number) => {
    setPhase({ step: "checking", path });
    try {
      const quality = await cloneRefQuality(path);
      const checks = evaluateCloneRef(quality);
      const passed = checks.every((c) => c.pass);
      setPhase({ step: "review", path, durationMs, checks, passed });
      if (passed) {
        // Default transcript: local Whisper over the take, user-correctable.
        setTranscribing(true);
        try {
          const result = await asrTranscribeFile(path);
          setTranscript(result.text.trim());
        } catch (err) {
          // No transcript is not fatal — the user can type it.
          setError(`Transcription failed — type the transcript manually. (${err})`);
        } finally {
          setTranscribing(false);
        }
      }
    } catch (err) {
      setPhase({ step: "idle" });
      setError(String(err));
    }
  }, []);

  const handleEvent = React.useCallback(
    (event: RecorderEvent) => {
      switch (event.type) {
        case "level":
          setLevel({ rms: event.rms, peak: event.peak });
          break;
        case "saved":
          recorderRef.current = null;
          setLevel({ rms: 0, peak: 0 });
          void analyze(event.path, Math.round(event.durationSecs * 1000));
          break;
        case "cancelled":
          recorderRef.current = null;
          setLevel({ rms: 0, peak: 0 });
          setPhase({ step: "idle" });
          break;
        case "error":
          recorderRef.current = null;
          setPhase({ step: "idle" });
          setError(event.message);
          break;
      }
    },
    [analyze],
  );

  const record = React.useCallback(async () => {
    setError(null);
    setTranscript("");
    setConsent(false);
    try {
      const id = await startCloneRefRecording(person.id, REF_SLOT, handleEvent);
      recorderRef.current = id;
      setPhase({ step: "recording", recorderId: id });
    } catch (err) {
      setError(String(err));
    }
  }, [handleEvent, person.id]);

  async function save() {
    if (phase.step !== "review" || !phase.passed || !consent) return;
    const text = transcript.trim();
    if (!text) return;
    setSaving(true);
    setError(null);
    try {
      await update(person.id, {
        cloneRef: {
          samples: [{ path: REF_PATH, durationMs: phase.durationMs }],
          transcript: text,
          consentConfirmed: true,
        },
        clones: {
          ...person.clones,
          zipvoice: { refAudio: REF_PATH, refText: text },
        },
      });
      setPhase({ step: "idle" });
      setTranscript("");
      setConsent(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!isDesktop()) {
    return (
      <p className="text-muted-foreground text-sm">
        Voice cloning requires the desktop app.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {person.cloneRef && phase.step === "idle" && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <Check className="h-3.5 w-3.5" /> Clone reference ready ·{" "}
            {((person.cloneRef.samples[0]?.durationMs ?? 0) / 1000).toFixed(1)} s
          </span>
          <p className="mt-1 line-clamp-2 text-muted-foreground text-xs">
            “{person.cloneRef.transcript}”
          </p>
        </div>
      )}

      <p className="text-muted-foreground text-sm">
        Record one clean take, roughly 10–60 seconds, in a quiet space — read a
        paragraph or speak freely, close to the mic. The cloned voice can only
        be as good as this reference.
      </p>

      {phase.step === "recording" ? (
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="destructive"
            onClick={() => void stopRecording(phase.recorderId)}
          >
            <Square className="mr-1 h-4 w-4" /> Stop
          </Button>
          <LevelMeter rms={level.rms} peak={level.peak} />
        </div>
      ) : phase.step === "checking" ? (
        <span className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking recording
          quality…
        </span>
      ) : (
        <div>
          <Button size="sm" onClick={() => void record()}>
            {person.cloneRef || phase.step === "review" ? (
              <RotateCcw className="mr-1 h-4 w-4" />
            ) : (
              <Circle className="mr-1 h-3 w-3 fill-destructive text-destructive" />
            )}
            {person.cloneRef || phase.step === "review"
              ? "Re-record reference"
              : "Record reference"}
          </Button>
        </div>
      )}

      {phase.step === "review" && (
        <TakeReview
          checks={phase.checks}
          passed={phase.passed}
          path={phase.path}
        />
      )}

      {phase.step === "review" && phase.passed && (
        <div className="flex flex-col gap-3">
          <div>
            <p className="mb-1 font-medium text-xs uppercase tracking-wide text-muted-foreground">
              Transcript of the recording
            </p>
            {transcribing ? (
              <span className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" /> Transcribing…
              </span>
            ) : (
              <>
                <Textarea
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                  rows={3}
                  placeholder="Exactly what was said in the recording"
                />
                <p className="mt-1 text-muted-foreground text-xs">
                  Correct this to match the recording word for word — the clone
                  conditions on the pair, and mismatches degrade similarity.
                </p>
              </>
            )}
          </div>

          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={consent}
              onCheckedChange={(v) => setConsent(v === true)}
              className="mt-0.5"
            />
            <span>
              This is my own voice, or I have this person's consent to clone
              their voice.
            </span>
          </label>

          <div>
            <Button
              onClick={() => void save()}
              disabled={saving || transcribing || !consent || !transcript.trim()}
            >
              {saving ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-1 h-4 w-4" />
              )}
              Save clone reference
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

/** Per-take quality report: all four checks, pass or fail, plus re-record
 * advice for the first failure. */
function TakeReview({
  checks,
  passed,
  path,
}: {
  checks: QualityCheck[];
  passed: boolean;
  path: string;
}) {
  const advice = cloneRefAdvice(checks);
  const [audio, setAudio] = React.useState<HTMLAudioElement | null>(null);

  React.useEffect(() => {
    return () => audio?.pause();
  }, [audio]);

  return (
    <div
      className={cn(
        "rounded-md border p-3",
        passed
          ? "border-emerald-500/40 bg-emerald-500/5"
          : "border-destructive/40 bg-destructive/5",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {checks.map((check) => (
          <span
            key={check.code}
            className={cn(
              "flex items-center gap-1 text-xs",
              check.pass
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-destructive",
            )}
          >
            {check.pass ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <X className="h-3.5 w-3.5" />
            )}
            {check.label}
            <span className="text-muted-foreground">({check.detail})</span>
          </span>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 px-2 text-xs"
          onClick={() => {
            audio?.pause();
            const el = new Audio(audioUrl(path));
            setAudio(el);
            void el.play();
          }}
        >
          <Play className="mr-1 h-3 w-3" /> Listen
        </Button>
      </div>
      {!passed && advice && (
        <p className="mt-2 text-destructive text-xs">{advice}</p>
      )}
    </div>
  );
}
