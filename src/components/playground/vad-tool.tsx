import { Activity, Loader2, Play, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type BenchInput, InputSourcePanel } from "@/components/bench/input-source-panel";
import { LevelMeter } from "@/components/bench/level-meter";
import { ParamPanel } from "@/components/bench/param-panel";
import { RecentRuns } from "@/components/bench/recent-runs";
import { Waveform, type WaveformHandle } from "@/components/bench/waveform";
import { EngineChip } from "@/components/shared/engine-chip";
import { Button } from "@/components/ui/button";
import { defaultParams } from "@/lib/engines/descriptors";
import {
  type PipelineEvent,
  startVadPipeline,
  stopAsrPipeline,
  type VadAnalysis,
  vadAnalyzeFile,
} from "@/lib/engines/local";
import { useEngineResolution } from "@/lib/routing/use-engine";
import type { PlaygroundRun } from "@/lib/schemas/playground";
import { isDesktop } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { usePlaygroundStore } from "@/stores/playground-store";

const TOOL = "vad";

/** Rolling live timeline: state flips over the last LIVE_WINDOW seconds. */
const LIVE_WINDOW = 30;

interface Flip {
  at: number; // seconds since monitor start
  speaking: boolean;
}

export function VadTool() {
  const [engineOverride, setEngineOverride] = useState<string | null>(null);
  const engine = useEngineResolution("vad", engineOverride).active;
  const [params, setParams] = useState<Record<string, unknown>>(() =>
    engine ? defaultParams(engine) : {},
  );

  const setParam = useCallback(
    (key: string, value: unknown) => setParams((p) => ({ ...p, [key]: value })),
    [],
  );

  const vadParams = {
    threshold: typeof params.threshold === "number" ? params.threshold : undefined,
    minSilence: typeof params.minSilence === "number" ? params.minSilence : undefined,
    minSpeech: typeof params.minSpeech === "number" ? params.minSpeech : undefined,
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-xl">Voice activity detection</h1>
          <p className="text-muted-foreground text-sm">
            Speech/silence detection — monitor the mic live or analyze a file.
          </p>
        </div>
        <EngineChip
          task="vad"
          override={engineOverride}
          onOverride={setEngineOverride}
        />
      </header>

      <ParamPanel
        specs={engine?.params ?? []}
        values={params}
        onChange={setParam}
      />

      {!isDesktop() && (
        <p className="text-muted-foreground text-sm">
          Voice activity detection requires the desktop app.
        </p>
      )}

      <LiveMonitor vadParams={vadParams} disabled={!engine} />
      <FileAnalysis
        vadParams={vadParams}
        params={params}
        setParams={setParams}
        engineId={engine?.id ?? null}
        disabled={!engine}
      />
    </div>
  );
}

interface VadParamValues {
  threshold?: number;
  minSilence?: number;
  minSpeech?: number;
}

function LiveMonitor({
  vadParams,
  disabled,
}: {
  vadParams: VadParamValues;
  disabled: boolean;
}) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState({ rms: 0, peak: 0 });
  const [flips, setFlips] = useState<Flip[]>([]);
  const [clock, setClock] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const pipelineId = useRef<number | null>(null);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!listening) return;
    const timer = setInterval(
      () => setClock((performance.now() - startedAt.current) / 1000),
      100,
    );
    return () => clearInterval(timer);
  }, [listening]);

  const handleEvent = useCallback((event: PipelineEvent) => {
    switch (event.type) {
      case "ready":
        startedAt.current = performance.now();
        setFlips([{ at: 0, speaking: false }]);
        setListening(true);
        break;
      case "level":
        setLevel({ rms: event.rms, peak: event.peak });
        break;
      case "vadState": {
        const at = (performance.now() - startedAt.current) / 1000;
        setSpeaking(event.speaking);
        setFlips((prev) => [...prev, { at, speaking: event.speaking }]);
        break;
      }
      case "error":
        setError(event.message);
        setListening(false);
        pipelineId.current = null;
        break;
      case "stopped":
        setListening(false);
        setSpeaking(false);
        pipelineId.current = null;
        break;
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      pipelineId.current = await startVadPipeline({
        ...vadParams,
        onEvent: handleEvent,
      });
    } catch (err) {
      setError(String(err));
    }
  }, [vadParams, handleEvent]);

  const stop = useCallback(() => {
    if (pipelineId.current !== null) void stopAsrPipeline(pipelineId.current);
  }, []);

  // Stop the pipeline when navigating away.
  useEffect(() => {
    return () => {
      if (pipelineId.current !== null) void stopAsrPipeline(pipelineId.current);
    };
  }, []);

  return (
    <section className="space-y-3 rounded-md border border-border p-4">
      <div className="flex items-center gap-3">
        <h2 className="flex-1 font-medium text-sm">Live monitor</h2>
        {listening ? (
          <>
            <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <span
                className={cn(
                  "h-2.5 w-2.5 rounded-full transition-colors",
                  speaking ? "bg-primary" : "bg-muted-foreground/30",
                )}
              />
              {speaking ? "speech" : "silence"}
            </span>
            <Button size="sm" variant="destructive" onClick={stop}>
              <Square className="mr-1 h-4 w-4" /> Stop
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={start} disabled={disabled || !isDesktop()}>
            <Activity className="mr-1 h-4 w-4" /> Listen
          </Button>
        )}
      </div>
      {listening && (
        <>
          <LevelMeter rms={level.rms} peak={level.peak} />
          <LiveTimeline flips={flips} now={clock} />
        </>
      )}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </section>
  );
}

/** Speech/silence strip over the trailing LIVE_WINDOW seconds. */
function LiveTimeline({ flips, now }: { flips: Flip[]; now: number }) {
  const windowStart = Math.max(0, now - LIVE_WINDOW);
  const spans: { left: number; width: number; speaking: boolean }[] = [];
  for (let i = 0; i < flips.length; i++) {
    const start = Math.max(flips[i].at, windowStart);
    const end = i + 1 < flips.length ? flips[i + 1].at : now;
    if (end <= windowStart) continue;
    spans.push({
      left: ((start - windowStart) / LIVE_WINDOW) * 100,
      width: (Math.max(0, end - start) / LIVE_WINDOW) * 100,
      speaking: flips[i].speaking,
    });
  }
  return (
    <div
      className="relative h-4 w-full overflow-hidden rounded bg-muted"
      aria-label="Speech activity timeline"
    >
      {spans.map(
        (span) =>
          span.speaking && (
            <div
              key={span.left}
              className="absolute h-full bg-primary/70"
              style={{ left: `${span.left}%`, width: `${span.width}%` }}
            />
          ),
      )}
    </div>
  );
}

function FileAnalysis({
  vadParams,
  params,
  setParams,
  engineId,
  disabled,
}: {
  vadParams: VadParamValues;
  params: Record<string, unknown>;
  setParams: (params: Record<string, unknown>) => void;
  engineId: string | null;
  disabled: boolean;
}) {
  const [input, setInput] = useState<BenchInput | null>(null);
  const [analysis, setAnalysis] = useState<VadAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const waveformRef = useRef<WaveformHandle | null>(null);
  const addRun = usePlaygroundStore((s) => s.addRun);

  const analyze = useCallback(async () => {
    if (!input || busy) return;
    setBusy(true);
    setError(null);
    setSelectedRunId(null);
    const startedAt = performance.now();
    try {
      const result = await vadAnalyzeFile(input.path, vadParams);
      setAnalysis(result);
      await addRun({
        tool: TOOL,
        engineId,
        durationMs: Math.round(performance.now() - startedAt),
        input,
        params,
        result,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [input, busy, vadParams, params, engineId, addRun]);

  const restoreRun = useCallback(
    (saved: PlaygroundRun) => {
      if (saved.input.path) {
        setInput({
          kind: (saved.input.kind === "text" ? "file" : saved.input.kind) as BenchInput["kind"],
          path: saved.input.path,
          name: saved.input.name ?? saved.input.path,
        });
      }
      setParams(saved.params);
      setAnalysis(saved.result as VadAnalysis);
      setError(null);
      setSelectedRunId(saved.id);
    },
    [setParams],
  );

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-sm">Analyze a clip</h2>
        <Button
          size="sm"
          onClick={analyze}
          disabled={disabled || busy || !input || !isDesktop()}
        >
          {busy ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Activity className="mr-1 h-4 w-4" />
          )}
          Analyze
        </Button>
      </div>

      <InputSourcePanel value={input} onChange={setInput} disabled={busy} />

      {error && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm">
          {error}
        </p>
      )}

      {input && analysis && (
        <div className="space-y-3 rounded-md border border-border bg-card p-4">
          <Waveform
            ref={waveformRef}
            path={input.path}
            segments={analysis.segments}
          />
          <p className="text-muted-foreground text-xs">
            {analysis.segments.length} speech segment
            {analysis.segments.length === 1 ? "" : "s"} in{" "}
            {analysis.durationSecs.toFixed(1)} s (
            {(
              (analysis.segments.reduce((sum, s) => sum + (s.end - s.start), 0) /
                Math.max(analysis.durationSecs, 0.001)) *
              100
            ).toFixed(0)}
            % speech)
          </p>
          {analysis.segments.length > 0 && (
            <ul className="max-h-48 space-y-0.5 overflow-y-auto">
              {analysis.segments.map((segment, i) => (
                <li
                  key={`${segment.start}-${segment.end}`}
                  className="flex items-center gap-2 text-xs"
                >
                  <button
                    type="button"
                    onClick={() =>
                      waveformRef.current?.playRange(segment.start, segment.end)
                    }
                    aria-label={`Play segment ${i + 1}`}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Play className="h-3.5 w-3.5" />
                  </button>
                  <span className="text-muted-foreground tabular-nums">
                    #{i + 1}
                  </span>
                  <span className="tabular-nums">
                    {segment.start.toFixed(2)} s → {segment.end.toFixed(2)} s
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    ({(segment.end - segment.start).toFixed(2)} s)
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <RecentRuns
        tool={TOOL}
        selectedId={selectedRunId}
        onSelect={restoreRun}
        summarize={(saved) => {
          const result = saved.result as VadAnalysis | null;
          return result
            ? `${result.segments.length} segments / ${result.durationSecs.toFixed(1)} s`
            : "—";
        }}
      />
    </section>
  );
}
