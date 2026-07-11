import { Clock, Mic, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LevelMeter } from "@/components/bench/level-meter";
import { EngineChip } from "@/components/shared/engine-chip";
import { Button } from "@/components/ui/button";
import {
  type PipelineEvent,
  startAsrPipeline,
  stopAsrPipeline,
  type WordSpan,
} from "@/lib/engines/local";
import { useEngineResolution } from "@/lib/routing/use-engine";
import { isDesktop } from "@/lib/storage";
import { cn } from "@/lib/utils";

type Status = "idle" | "starting" | "listening" | "stopping";

interface FinalSegment {
  text: string;
  words: WordSpan[];
}

/** Rolling decode-latency stats over the partials of a session. */
interface LatencyStats {
  count: number;
  lastMs: number;
  avgMs: number;
}

/**
 * Live mic-streaming ASR demo (spec §2.3) — the streaming-decode capability
 * preserved as a Playground-only page. Chat, live sessions, and dictation
 * all moved to VAD-gated batch decoding per utterance; this page is the one
 * remaining consumer of `StreamingAsrSession` / incremental `partial` events.
 */
export function StreamingRecognitionTool() {
  const [status, setStatus] = useState<Status>("idle");
  const [device, setDevice] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState({ rms: 0, peak: 0 });
  const [partial, setPartial] = useState("");
  const [finals, setFinals] = useState<FinalSegment[]>([]);
  const [latency, setLatency] = useState<LatencyStats | null>(null);
  const [showTiming, setShowTiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [engineOverride, setEngineOverride] = useState<string | null>(null);
  const engine = useEngineResolution("streamingAsr", engineOverride).active;
  const pipelineId = useRef<number | null>(null);
  const latencySumMs = useRef(0);

  const handleEvent = useCallback((event: PipelineEvent) => {
    switch (event.type) {
      case "ready":
        setStatus("listening");
        setDevice(event.device);
        latencySumMs.current = 0;
        setLatency(null);
        break;
      case "partial":
        setPartial(event.text);
        latencySumMs.current += event.latencyMs;
        setLatency((prev) => {
          const count = (prev?.count ?? 0) + 1;
          return {
            count,
            lastMs: event.latencyMs,
            avgMs: latencySumMs.current / count,
          };
        });
        break;
      case "final":
        setFinals((prev) => [...prev, { text: event.text, words: event.words }]);
        setPartial("");
        break;
      case "vadState":
        setSpeaking(event.speaking);
        break;
      case "level":
        setLevel({ rms: event.rms, peak: event.peak });
        break;
      case "error":
        setError(event.message);
        setStatus("idle");
        pipelineId.current = null;
        break;
      case "stopped":
        setStatus("idle");
        setSpeaking(false);
        pipelineId.current = null;
        break;
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setStatus("starting");
    try {
      pipelineId.current = await startAsrPipeline({ onEvent: handleEvent });
    } catch (err) {
      setError(String(err));
      setStatus("idle");
    }
  }, [handleEvent]);

  const stop = useCallback(async () => {
    if (pipelineId.current === null) return;
    setStatus("stopping");
    try {
      await stopAsrPipeline(pipelineId.current);
    } catch (err) {
      setError(String(err));
      setStatus("idle");
    }
  }, []);

  // Stop the pipeline when navigating away.
  useEffect(() => {
    return () => {
      if (pipelineId.current !== null) {
        void stopAsrPipeline(pipelineId.current);
      }
    };
  }, []);

  const listening = status === "listening";

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 overflow-y-auto p-6">
      <section className="flex min-h-[50%] flex-col gap-4">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="font-semibold text-xl">Streaming Recognition</h1>
            <p className="text-muted-foreground text-sm">
              Live streaming transcription, fully on-device.
            </p>
          </div>
          <EngineChip
            task="streamingAsr"
            override={engineOverride}
            onOverride={setEngineOverride}
          />
        </header>

        <div className="flex items-center gap-3">
          {listening ? (
            <Button onClick={stop} variant="destructive" size="sm">
              <Square className="mr-1 h-4 w-4" /> Stop
            </Button>
          ) : (
            <Button
              onClick={start}
              size="sm"
              disabled={status !== "idle" || !isDesktop() || !engine}
            >
              <Mic className="mr-1 h-4 w-4" />
              {status === "starting" ? "Starting…" : "Start listening"}
            </Button>
          )}
          {listening && (
            <span className="flex items-center gap-2 text-muted-foreground text-xs">
              <span
                className={cn(
                  "h-2.5 w-2.5 rounded-full transition-colors",
                  speaking ? "bg-green-500" : "bg-muted-foreground/30",
                )}
              />
              {speaking ? "speech" : "silence"}
              {device && <span>· {device}</span>}
            </span>
          )}
          {latency && (
            <span className="ml-auto text-muted-foreground text-xs tabular-nums">
              decode {latency.lastMs.toFixed(0)} ms · avg{" "}
              {latency.avgMs.toFixed(0)} ms · {latency.count} partials
            </span>
          )}
        </div>

        {listening && <LevelMeter rms={level.rms} peak={level.peak} />}

        {!isDesktop() && (
          <p className="text-muted-foreground text-sm">
            Local speech recognition requires the desktop app.
          </p>
        )}
        {error && (
          <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm">
            {error}
          </p>
        )}

        <div className="dark:bg-input/30 min-h-32 flex-1 space-y-2 overflow-y-auto rounded-md border border-input bg-background p-4">
          {finals.length === 0 && !partial && (
            <p className="text-muted-foreground text-sm">
              Transcript appears here — press Start and speak.
            </p>
          )}
          {finals.map((segment, i) => (
            // Finals are append-only; index identity is stable.
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
            <FinalLine key={i} segment={segment} showTiming={showTiming} />
          ))}
          {partial && (
            <p className="text-muted-foreground text-sm italic leading-relaxed">
              {partial}
            </p>
          )}
        </div>

        {finals.length > 0 && (
          <div className="flex justify-end gap-2">
            <Button
              variant={showTiming ? "secondary" : "outline"}
              size="sm"
              onClick={() => setShowTiming((v) => !v)}
            >
              <Clock className="mr-1 h-4 w-4" /> Word timing
            </Button>
            <Button variant="outline" size="sm" onClick={() => setFinals([])}>
              Clear
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

/** One final segment; with timing on, each word shows its utterance-relative
 *  start (streaming finals always carry word timestamps). */
function FinalLine({
  segment,
  showTiming,
}: {
  segment: FinalSegment;
  showTiming: boolean;
}) {
  if (!showTiming || segment.words.length === 0) {
    return <p className="text-sm leading-relaxed">{segment.text}</p>;
  }
  return (
    <p className="text-sm leading-relaxed">
      {segment.words.map((word, i) => (
        <span key={`${word.start}-${word.text}`}>
          <span title={`${word.start.toFixed(2)} s`}>{word.text}</span>
          <sup className="ml-0.5 text-[0.6rem] text-muted-foreground tabular-nums">
            {word.start.toFixed(1)}
          </sup>
          {i + 1 < segment.words.length ? " " : ""}
        </span>
      ))}
    </p>
  );
}
