import { Loader2, UserCheck } from "lucide-react";
import { useCallback, useState } from "react";
import { type BenchInput, InputSourcePanel } from "@/components/bench/input-source-panel";
import { ParamPanel } from "@/components/bench/param-panel";
import { RecentRuns } from "@/components/bench/recent-runs";
import { EngineChip } from "@/components/shared/engine-chip";
import { Button } from "@/components/ui/button";
import { defaultParams } from "@/lib/engines/descriptors";
import { type SpeakerCompareResult, speakerCompareFiles } from "@/lib/engines/local";
import { useEngineResolution } from "@/lib/routing/use-engine";
import type { PlaygroundRun } from "@/lib/schemas/playground";
import { isDesktop } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { usePlaygroundStore } from "@/stores/playground-store";

const TOOL = "speaker-verify";

/** Persisted run result: the comparison plus clip B (clip A is run.input). */
interface VerifyRunResult {
  compare: SpeakerCompareResult;
  inputB: { path: string; name: string };
}

export function SpeakerVerifyTool() {
  const [engineOverride, setEngineOverride] = useState<string | null>(null);
  const engine = useEngineResolution("speakerVerify", engineOverride).active;
  const [params, setParams] = useState<Record<string, unknown>>(() =>
    engine ? defaultParams(engine) : {},
  );
  const [inputA, setInputA] = useState<BenchInput | null>(null);
  const [inputB, setInputB] = useState<BenchInput | null>(null);
  const [result, setResult] = useState<SpeakerCompareResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const addRun = usePlaygroundStore((s) => s.addRun);

  const setParam = useCallback(
    (key: string, value: unknown) => setParams((p) => ({ ...p, [key]: value })),
    [],
  );

  const compare = useCallback(async () => {
    if (!inputA || !inputB || busy) return;
    setBusy(true);
    setError(null);
    setSelectedRunId(null);
    const startedAt = performance.now();
    try {
      const compared = await speakerCompareFiles(inputA.path, inputB.path, {
        threshold: typeof params.threshold === "number" ? params.threshold : undefined,
      });
      setResult(compared);
      const persisted: VerifyRunResult = {
        compare: compared,
        inputB: { path: inputB.path, name: inputB.name },
      };
      await addRun({
        tool: TOOL,
        engineId: engine?.id ?? null,
        durationMs: Math.round(performance.now() - startedAt),
        input: inputA,
        params,
        result: persisted,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [inputA, inputB, busy, params, engine, addRun]);

  const restoreRun = useCallback((saved: PlaygroundRun) => {
    const persisted = saved.result as VerifyRunResult | null;
    if (saved.input.path) {
      setInputA({
        kind: "file",
        path: saved.input.path,
        name: saved.input.name ?? saved.input.path,
      });
    }
    if (persisted?.inputB) {
      setInputB({ kind: "file", ...persisted.inputB });
    }
    setParams(saved.params);
    setResult(persisted?.compare ?? null);
    setError(null);
    setSelectedRunId(saved.id);
  }, []);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-xl">Speaker verification</h1>
          <p className="text-muted-foreground text-sm">
            Are two clips the same voice? Compares speaker embeddings.
          </p>
        </div>
        <EngineChip
          task="speakerVerify"
          override={engineOverride}
          onOverride={setEngineOverride}
        />
      </header>

      <ParamPanel specs={engine?.params ?? []} values={params} onChange={setParam} />

      {!isDesktop() && (
        <p className="text-muted-foreground text-sm">
          Speaker verification requires the desktop app.
        </p>
      )}

      <section className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <h2 className="font-medium text-sm">Clip A</h2>
          <InputSourcePanel value={inputA} onChange={setInputA} disabled={busy} />
        </div>
        <div className="space-y-2">
          <h2 className="font-medium text-sm">Clip B</h2>
          <InputSourcePanel value={inputB} onChange={setInputB} disabled={busy} />
        </div>
      </section>

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={compare}
          disabled={!engine || busy || !inputA || !inputB || !isDesktop()}
        >
          {busy ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <UserCheck className="mr-1 h-4 w-4" />
          )}
          Compare
        </Button>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm">
          {error}
        </p>
      )}

      {result && <VerifyResult result={result} />}

      <RecentRuns
        tool={TOOL}
        selectedId={selectedRunId}
        onSelect={restoreRun}
        summarize={(saved) => {
          const persisted = saved.result as VerifyRunResult | null;
          if (!persisted) return "—";
          return `${persisted.compare.similarity.toFixed(2)} · ${
            persisted.compare.isMatch ? "same voice" : "different voices"
          }`;
        }}
      />
    </div>
  );
}

function VerifyResult({ result }: { result: SpeakerCompareResult }) {
  // Similarity gauge over [-1, 1] with the decision threshold marked.
  const position = ((result.similarity + 1) / 2) * 100;
  const thresholdPosition = ((result.threshold + 1) / 2) * 100;
  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-4">
      <div className="flex items-baseline gap-3">
        <span className="font-semibold text-2xl tabular-nums">
          {result.similarity.toFixed(3)}
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-medium text-xs",
            result.isMatch
              ? "bg-primary/15 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {result.isMatch ? "Same voice" : "Different voices"}
        </span>
      </div>
      <div
        className="relative h-2 w-full rounded bg-muted"
        aria-label="Similarity gauge"
      >
        <div
          className="absolute h-full rounded bg-primary/70"
          style={{ width: `${Math.max(0, Math.min(position, 100))}%` }}
        />
        <div
          className="absolute top-[-3px] h-3.5 w-0.5 bg-foreground/60"
          style={{ left: `${thresholdPosition}%` }}
          title={`Threshold ${result.threshold.toFixed(2)}`}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Cosine similarity of {result.embeddingDim}-dim embeddings · threshold{" "}
        {result.threshold.toFixed(2)} · {result.processingMs.toFixed(0)} ms
      </p>
    </section>
  );
}
