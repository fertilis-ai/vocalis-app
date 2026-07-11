import * as React from "react";
import {
  Loader2,
  Mic,
  MoreVertical,
  Square,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { ExportMenu } from "@/components/sessions/export-menu";
import { TranscriptList } from "@/components/sessions/transcript-list";
import { Waveform, type WaveformHandle } from "@/components/bench/waveform";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { msToClock } from "@/lib/exports/format";
import type { SpeakerRef, Transcript } from "@/lib/schemas/session";
import {
  assignPerson,
  editSegmentText,
  reassignSpeaker,
  renameSpeaker,
} from "@/lib/sessions/edits";
import { mergeSpeakers, speakerDisplay } from "@/lib/sessions/transcript";
import { useSessionRecorder } from "@/lib/sessions/use-session-recorder";
import { deletePath, getAppDataDir, pathExists } from "@/lib/storage";
import { sessionAudioPath, useSessionStore } from "@/stores/session-store";
import { usePeopleStore } from "@/stores/people-store";

// The transcription session view (spec §2.2B, M3 item 5). Renders a session's
// transcript as speaker bubbles, drives live capture, offers speaker edits, an
// audio scrubber over the retained capture, exports, and the retention toggle.

interface SessionViewProps {
  sessionId: string;
}

export function SessionView({ sessionId }: SessionViewProps) {
  const session = useSessionStore((s) => s.sessions[sessionId]);
  const transcript = useSessionStore((s) => s.transcripts[sessionId]) ?? [];
  const loadSession = useSessionStore((s) => s.loadSession);
  const loadTranscript = useSessionStore((s) => s.loadTranscript);
  const people = usePeopleStore((s) => s.people);
  const loadPeople = usePeopleStore((s) => s.loadAll);

  const recorder = useSessionRecorder(sessionId);
  const waveformRef = React.useRef<WaveformHandle>(null);
  const [audioAvailable, setAudioAvailable] = React.useState(false);
  const [audioAbsolutePath, setAudioAbsolutePath] = React.useState<string | null>(null);

  React.useEffect(() => {
    void loadSession(sessionId);
    void loadTranscript(sessionId);
    void loadPeople();
  }, [sessionId, loadSession, loadTranscript, loadPeople]);

  // Whether a scrubber can be shown: retained audio that exists on disk and
  // isn't currently being captured. Re-checked when status changes because
  // audio.wav appears once a capture/import reaches "complete".
  const recording = recorder.status === "recording";
  const status = session?.status;
  React.useEffect(() => {
    let stale = false;
    if (recording || status === "recording" || !session?.audioRetained) {
      setAudioAvailable(false);
      setAudioAbsolutePath(null);
      return;
    }
    void pathExists(sessionAudioPath(sessionId)).then(async (exists) => {
      if (stale) return;
      setAudioAvailable(exists);
      if (!exists) {
        setAudioAbsolutePath(null);
        return;
      }
      // The waveform reads via the Tauri asset protocol, which — unlike the
      // fs commands above — does not tilde-expand, so it needs an absolute path.
      const dataDir = await getAppDataDir();
      if (!stale) setAudioAbsolutePath(dataDir ? `${dataDir}/sessions/${sessionId}/audio.wav` : null);
    });
    return () => {
      stale = true;
    };
  }, [sessionId, session?.audioRetained, recording, status]);

  const speakers: SpeakerRef[] = session?.speakers ?? [];
  const nameFor = React.useCallback(
    (label: string) => speakerDisplay(label, speakers, people).name,
    [speakers, people],
  );

  const store = useSessionStore.getState;

  async function applySpeakers(next: SpeakerRef[]) {
    await store().updateSession(sessionId, { speakers: next });
  }
  async function applyTranscript(next: Transcript, recompute = false) {
    await store().saveTranscript(sessionId, next);
    if (recompute) {
      await store().updateSession(sessionId, {
        speakers: mergeSpeakers(speakers, next),
      });
    }
  }

  async function discardAudio() {
    await deletePath(sessionAudioPath(sessionId));
    await store().updateSession(sessionId, { audioRetained: false });
    setAudioAvailable(false);
    toast.success("Audio discarded");
  }

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Loading session…
      </div>
    );
  }

  const liveMode = session.mode === "live";
  const processing =
    recorder.status === "processing" || session.status === "processing";
  const importing = !liveMode && session.status === "processing";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-2 py-2">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-medium">{session.title}</h1>
          <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <StatusDot status={session.status} recording={recording} />
            <span className="capitalize">{statusLabel(session, recorder.status)}</span>
            {session.durationMs ? <span>· {msToClock(session.durationMs)}</span> : null}
            {session.engineId ? <span>· {session.engineId}</span> : null}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {liveMode && <RecordButton recorder={recorder} />}
          <ExportMenu session={session} transcript={transcript} nameFor={nameFor} />
          <RetentionMenu
            audioRetained={session.audioRetained}
            canDiscard={audioAvailable}
            onToggleRetain={(retain) =>
              void store().updateSession(sessionId, { audioRetained: retain })
            }
            onDiscard={() => void discardAudio()}
          />
        </div>
      </header>

      {recorder.error && (
        <p className="border-destructive/30 border-b bg-destructive/10 px-4 py-2 text-destructive text-xs">
          {recorder.error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {importing && transcript.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-8 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Transcribing…
          </div>
        ) : (
          <TranscriptList
            transcript={transcript}
            speakers={speakers}
            people={people}
            statusLine={
              recording
                ? recorder.transcribingUtterance
                  ? "Transcribing…"
                  : "Listening…"
                : undefined
            }
            editable={!recording && !processing}
            onPlay={
              audioAvailable
                ? (startMs, endMs) =>
                    waveformRef.current?.playRange(startMs / 1000, endMs / 1000)
                : undefined
            }
            onRename={(label, name) =>
              void applySpeakers(renameSpeaker(speakers, label, name))
            }
            onResetName={(label) =>
              void applySpeakers(renameSpeaker(speakers, label, ""))
            }
            onAssign={(label, personId) =>
              void applySpeakers(assignPerson(speakers, label, personId))
            }
            onMerge={(from, to) =>
              void applyTranscript(reassignSpeaker(transcript, from, to), true)
            }
            onEditText={(id, text) =>
              void applyTranscript(editSegmentText(transcript, id, text))
            }
          />
        )}
      </div>

      {processing && (
        <div className="flex items-center gap-2 border-border border-t px-4 py-2 text-muted-foreground text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {recorder.processingMessage || "Refining speakers…"}
        </div>
      )}

      {audioAvailable && audioAbsolutePath && (
        <div className="border-border border-t px-4 py-3">
          <Waveform key={sessionId} ref={waveformRef} path={audioAbsolutePath} />
        </div>
      )}
    </div>
  );
}

function RecordButton({ recorder }: { recorder: ReturnType<typeof useSessionRecorder> }) {
  if (recorder.status === "recording") {
    return (
      <Button variant="destructive" size="sm" onClick={() => void recorder.stop()}>
        <Square className="mr-1.5 h-4 w-4 fill-current" /> Stop
      </Button>
    );
  }
  if (recorder.status === "processing") {
    return (
      <Button variant="outline" size="sm" disabled>
        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Refining…
      </Button>
    );
  }
  return (
    <Button size="sm" onClick={() => void recorder.start()}>
      <Mic className="mr-1.5 h-4 w-4" /> Record
    </Button>
  );
}

function RetentionMenu({
  audioRetained,
  canDiscard,
  onToggleRetain,
  onDiscard,
}: {
  audioRetained: boolean;
  canDiscard: boolean;
  onToggleRetain: (retain: boolean) => void;
  onDiscard: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-xs" className="h-8 w-8" />}
      >
        <MoreVertical className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Audio</DropdownMenuLabel>
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault();
              onToggleRetain(!audioRetained);
            }}
          >
            <Checkbox checked={audioRetained} className="mr-2" />
            Keep audio for playback
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {canDiscard && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onDiscard}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" /> Discard audio now
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function statusLabel(
  session: { status: string; mode: string },
  recorderStatus: string,
): string {
  if (recorderStatus === "recording") return "Recording";
  if (recorderStatus === "processing") return "Refining";
  switch (session.status) {
    case "draft":
      return session.mode === "live" ? "Ready to record" : "Draft";
    case "recording":
      return "Recording";
    case "processing":
      return session.mode === "import" ? "Transcribing" : "Refining";
    case "complete":
      return "Complete";
    case "error":
      return "Error";
    default:
      return session.status;
  }
}

function StatusDot({ status, recording }: { status: string; recording: boolean }) {
  const color =
    recording || status === "recording"
      ? "bg-destructive animate-pulse"
      : status === "complete"
        ? "bg-primary"
        : status === "error"
          ? "bg-destructive"
          : status === "processing"
            ? "bg-amber-500"
            : "bg-muted-foreground/50";
  return <span className={`h-2 w-2 rounded-full ${color}`} aria-hidden />;
}
