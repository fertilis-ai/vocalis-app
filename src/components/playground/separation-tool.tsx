import { Download, Loader2, Play, SplitSquareHorizontal } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import {
  type BenchInput,
  InputSourcePanel,
} from "@/components/bench/input-source-panel";
import { RecentRuns } from "@/components/bench/recent-runs";
import { Waveform, type WaveformHandle } from "@/components/bench/waveform";
import { EngineChip } from "@/components/shared/engine-chip";
import { Button } from "@/components/ui/button";
import { type SeparateResult, separateFile } from "@/lib/engines/local";
import { useEngineResolution } from "@/lib/routing/use-engine";
import type { PlaygroundRun } from "@/lib/schemas/playground";
import {
  copyFile,
  createDirectory,
  getAppDataDir,
  isDesktop,
  revealInFolder,
} from "@/lib/storage";
import { usePlaygroundStore } from "@/stores/playground-store";

// Source separation is file-input only (spec §2.3): the InputSourcePanel's mic
// tab records into the bench library, so we reuse it but stems come from a
// whole clip.
const TOOL = "separation";

export function SeparationTool() {
  const [engineOverride, setEngineOverride] = useState<string | null>(null);
  const engine = useEngineResolution("separation", engineOverride).active;

  const [input, setInput] = useState<BenchInput | null>(null);
  const [result, setResult] = useState<SeparateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const addRun = usePlaygroundStore((s) => s.addRun);

  const separate = useCallback(async () => {
    if (!input || busy) return;
    setBusy(true);
    setError(null);
    setSelectedRunId(null);
    const startedAt = performance.now();
    try {
      const res = await separateFile(input.path);
      setResult(res);
      await addRun({
        tool: TOOL,
        engineId: engine?.id ?? null,
        durationMs: Math.round(performance.now() - startedAt),
        input,
        params: {},
        result: res,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [input, busy, engine, addRun]);

  const restoreRun = useCallback((saved: PlaygroundRun) => {
    if (saved.input.path) {
      setInput({
        kind: (saved.input.kind === "text" ? "file" : saved.input.kind) as BenchInput["kind"],
        path: saved.input.path,
        name: saved.input.name ?? saved.input.path,
      });
    }
    setResult(saved.result as SeparateResult);
    setError(null);
    setSelectedRunId(saved.id);
  }, []);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-xl">Source separation</h1>
          <p className="text-muted-foreground text-sm">
            Split a clip into vocals and accompaniment (Spleeter 2-stems).
          </p>
        </div>
        <EngineChip task="separation" override={engineOverride} onOverride={setEngineOverride} />
      </header>

      {!isDesktop() && (
        <p className="text-muted-foreground text-sm">
          Source separation requires the desktop app.
        </p>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-sm">Separate a clip</h2>
          <Button
            size="sm"
            onClick={separate}
            disabled={!engine || busy || !input || !isDesktop()}
          >
            {busy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <SplitSquareHorizontal className="mr-1 h-4 w-4" />
            )}
            Separate
          </Button>
        </div>

        <InputSourcePanel value={input} onChange={setInput} disabled={busy} />

        {busy && (
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Separating — this is a batch job and can take a while on long clips.
          </p>
        )}

        {error && (
          <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm">
            {error}
          </p>
        )}

        {result && <Stems result={result} />}

        <RecentRuns
          tool={TOOL}
          selectedId={selectedRunId}
          onSelect={restoreRun}
          summarize={(saved) => {
            const res = saved.result as SeparateResult | null;
            return res
              ? `${res.stems.length} stems (${res.stems.map((s) => s.name).join(", ")})`
              : "—";
          }}
        />
      </section>
    </div>
  );
}

function Stems({ result }: { result: SeparateResult }) {
  // One Waveform handle per stem so "play" is exclusive: starting one stops
  // the others (spec: solo/mute as exclusive playback, no mixer).
  const handles = useRef<(WaveformHandle | null)[]>([]);

  const playSolo = useCallback((index: number) => {
    handles.current.forEach((handle, i) => {
      if (i !== index) handle?.stop();
    });
    handles.current[index]?.playRange(0);
  }, []);

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        {result.stems.length} stems in {result.processingMs.toFixed(0)} ms — play is
        exclusive (one stem at a time).
      </p>
      {result.stems.map((stem, i) => (
        <div key={stem.wavPath} className="space-y-2 rounded-md border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => playSolo(i)}
              aria-label={`Play ${stem.name}`}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Play className="h-4 w-4" />
            </button>
            <span className="flex-1 font-medium text-sm capitalize">{stem.name}</span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {stem.durationSecs.toFixed(1)} s
            </span>
            <ExportButton stem={stem} />
          </div>
          <Waveform
            ref={(handle) => {
              handles.current[i] = handle;
            }}
            path={stem.wavPath}
          />
        </div>
      ))}
    </div>
  );
}

function ExportButton({
  stem,
}: {
  stem: SeparateResult["stems"][number];
}) {
  const [state, setState] = useState<"idle" | "exporting" | "done">("idle");

  const exportStem = useCallback(async () => {
    setState("exporting");
    try {
      const dataDir = await getAppDataDir();
      if (!dataDir) throw new Error("no app data dir");
      const exportsDir = `${dataDir}/exports`;
      await createDirectory(exportsDir);
      const dest = `${exportsDir}/${stem.name}-${Date.now()}.wav`;
      await copyFile(stem.wavPath, dest);
      await revealInFolder(dest);
      setState("done");
    } catch (err) {
      console.error("[separation] export failed:", err);
      setState("idle");
    }
  }, [stem]);

  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={exportStem}
      disabled={state === "exporting"}
    >
      {state === "exporting" ? (
        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
      ) : (
        <Download className="mr-1 h-3.5 w-3.5" />
      )}
      {state === "done" ? "Exported" : "Export"}
    </Button>
  );
}
