import { open } from "@tauri-apps/plugin-dialog";
import { Circle, FileAudio, FolderOpen, Library, Mic, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  cancelRecording,
  type RecorderEvent,
  startRecording,
  stopRecording,
} from "@/lib/engines/local";
import { getAppDataDir, isDesktop, listFiles } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { LevelMeter } from "./level-meter";

// Bench input source picker (spec §2.3): record from the mic, pick a wav, or
// choose a saved recording. The selected input is always a path — audio
// bytes never enter the webview on this path.

export interface BenchInput {
  kind: "mic" | "file" | "library";
  path: string;
  name: string;
}

interface InputSourcePanelProps {
  value: BenchInput | null;
  onChange: (input: BenchInput | null) => void;
  disabled?: boolean;
}

type SourceTab = BenchInput["kind"];

const TABS: { id: SourceTab; label: string; icon: typeof Mic }[] = [
  { id: "mic", label: "Microphone", icon: Mic },
  { id: "file", label: "File", icon: FileAudio },
  { id: "library", label: "Library", icon: Library },
];

const LIBRARY_DIR = "recordings/bench";

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function InputSourcePanel({
  value,
  onChange,
  disabled,
}: InputSourcePanelProps) {
  const [tab, setTab] = useState<SourceTab>("mic");

  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center gap-1 border-border border-b p-1">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors",
              tab === id
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
        {value && (
          <span className="ml-auto flex items-center gap-1 pr-1 text-muted-foreground text-xs">
            <span className="max-w-48 truncate">{value.name}</span>
            <button
              type="button"
              onClick={() => onChange(null)}
              aria-label="Clear input"
              className="rounded p-0.5 hover:bg-accent"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
      </div>
      <div className="p-3">
        {!isDesktop() ? (
          <p className="text-muted-foreground text-sm">
            Audio input requires the desktop app.
          </p>
        ) : tab === "mic" ? (
          <MicSource onChange={onChange} disabled={disabled} />
        ) : tab === "file" ? (
          <FileSource onChange={onChange} disabled={disabled} />
        ) : (
          <LibrarySource value={value} onChange={onChange} disabled={disabled} />
        )}
      </div>
    </div>
  );
}

function MicSource({
  onChange,
  disabled,
}: {
  onChange: (input: BenchInput) => void;
  disabled?: boolean;
}) {
  const [recorderId, setRecorderId] = useState<number | null>(null);
  const [level, setLevel] = useState({ rms: 0, peak: 0 });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<number | null>(null);

  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(
      () => setElapsed((Date.now() - startedAt) / 1000),
      250,
    );
    return () => clearInterval(timer);
  }, [startedAt]);

  // A recording left running when the tool unmounts is discarded.
  useEffect(() => {
    return () => {
      if (recorderRef.current !== null) {
        void cancelRecording(recorderRef.current);
      }
    };
  }, []);

  const reset = useCallback(() => {
    recorderRef.current = null;
    setRecorderId(null);
    setStartedAt(null);
    setElapsed(0);
    setLevel({ rms: 0, peak: 0 });
  }, []);

  const handleEvent = useCallback(
    (event: RecorderEvent) => {
      switch (event.type) {
        case "ready":
          setStartedAt(Date.now());
          break;
        case "level":
          setLevel({ rms: event.rms, peak: event.peak });
          break;
        case "saved":
          reset();
          onChange({ kind: "mic", path: event.path, name: basename(event.path) });
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
    [onChange, reset],
  );

  const record = useCallback(async () => {
    setError(null);
    try {
      const id = await startRecording(handleEvent);
      recorderRef.current = id;
      setRecorderId(id);
    } catch (err) {
      setError(String(err));
    }
  }, [handleEvent]);

  const recording = recorderId !== null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        {recording ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => recorderId !== null && stopRecording(recorderId)}
            >
              <Square className="mr-1 h-4 w-4" /> Stop & use
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => recorderId !== null && cancelRecording(recorderId)}
            >
              Discard
            </Button>
            <span className="text-muted-foreground text-xs tabular-nums">
              {elapsed.toFixed(0)} s
            </span>
          </>
        ) : (
          <Button size="sm" onClick={record} disabled={disabled}>
            <Circle className="mr-1 h-3 w-3 fill-destructive text-destructive" />
            Record
          </Button>
        )}
      </div>
      {recording && <LevelMeter rms={level.rms} peak={level.peak} />}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

function FileSource({
  onChange,
  disabled,
}: {
  onChange: (input: BenchInput) => void;
  disabled?: boolean;
}) {
  const pick = useCallback(async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "flac"] }],
    });
    if (typeof path === "string") {
      onChange({ kind: "file", path, name: basename(path) });
    }
  }, [onChange]);

  return (
    <div className="flex items-center gap-3">
      <Button size="sm" variant="outline" onClick={pick} disabled={disabled}>
        <FolderOpen className="mr-1 h-4 w-4" /> Choose file…
      </Button>
      <p className="text-muted-foreground text-xs">wav, mp3, m4a, or flac.</p>
    </div>
  );
}

function LibrarySource({
  value,
  onChange,
  disabled,
}: {
  value: BenchInput | null;
  onChange: (input: BenchInput) => void;
  disabled?: boolean;
}) {
  const [clips, setClips] = useState<{ path: string; name: string }[] | null>(
    null,
  );

  useEffect(() => {
    let stale = false;
    void (async () => {
      const dataDir = await getAppDataDir();
      if (!dataDir) return setClips([]);
      // list_files returns stems; recordings are always wav.
      const stems = await listFiles(`${dataDir}/${LIBRARY_DIR}`, "wav");
      if (stale) return;
      setClips(
        stems
          .reverse() // rec-<timestamp> stems: newest last alphabetically
          .map((stem) => ({
            path: `${dataDir}/${LIBRARY_DIR}/${stem}.wav`,
            name: `${stem}.wav`,
          })),
      );
    })();
    return () => {
      stale = true;
    };
  }, []);

  if (clips === null) {
    return <p className="text-muted-foreground text-xs">Loading…</p>;
  }
  if (clips.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        No saved recordings yet — clips you record here are kept in
        ~/.vocalis/recordings/bench/.
      </p>
    );
  }
  return (
    <ul className="max-h-40 space-y-0.5 overflow-y-auto">
      {clips.map((clip) => (
        <li key={clip.path}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ kind: "library", ...clip })}
            className={cn(
              "w-full truncate rounded px-2 py-1 text-left text-xs transition-colors hover:bg-accent",
              value?.path === clip.path && "bg-secondary",
            )}
          >
            {clip.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
