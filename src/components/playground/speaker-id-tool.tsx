import { Loader2, Plus, Trash2, UserCheck, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type BenchInput, InputSourcePanel } from "@/components/bench/input-source-panel";
import { ParamPanel } from "@/components/bench/param-panel";
import { RecentRuns } from "@/components/bench/recent-runs";
import { EngineChip } from "@/components/shared/engine-chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { defaultParams } from "@/lib/engines/descriptors";
import {
  type EnrolledClip,
  type SpeakerIdentifyResult,
  speakerIdentifyFile,
} from "@/lib/engines/local";
import { useEngineResolution } from "@/lib/routing/use-engine";
import type { PlaygroundRun } from "@/lib/schemas/playground";
import { getAppDataDir, isDesktop } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { usePeopleStore } from "@/stores/people-store";
import { usePlaygroundStore } from "@/stores/playground-store";

const TOOL = "speaker-id";

interface EnrollmentRow {
  key: number;
  name: string;
  input: BenchInput | null;
}

/** Persisted run result: scores plus the enrollment set that produced them. */
interface IdentifyRunResult {
  identify: SpeakerIdentifyResult;
  enrolled: EnrolledClip[];
}

let nextRowKey = 0;
function newRow(name = "", input: BenchInput | null = null): EnrollmentRow {
  nextRowKey += 1;
  return { key: nextRowKey, name, input };
}

export function SpeakerIdTool() {
  const [engineOverride, setEngineOverride] = useState<string | null>(null);
  const engine = useEngineResolution("speakerId", engineOverride).active;
  const [params, setParams] = useState<Record<string, unknown>>(() =>
    engine ? defaultParams(engine) : {},
  );
  const [rows, setRows] = useState<EnrollmentRow[]>(() => [newRow(), newRow()]);
  const [probe, setProbe] = useState<BenchInput | null>(null);
  const [result, setResult] = useState<SpeakerIdentifyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const addRun = usePlaygroundStore((s) => s.addRun);

  const setParam = useCallback(
    (key: string, value: unknown) => setParams((p) => ({ ...p, [key]: value })),
    [],
  );

  const updateRow = useCallback((key: number, patch: Partial<EnrollmentRow>) => {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }, []);

  // Enrolled People (M3 item 3) can seed the reference set directly: one row per
  // enrollment clip, sharing the person's name so the identify manager averages
  // them (same behavior as re-enrolling names by hand).
  const people = usePeopleStore((s) => s.people);
  const loadPeople = usePeopleStore((s) => s.loadAll);
  useEffect(() => {
    void loadPeople();
  }, [loadPeople]);
  const enrolledPeople = Object.values(people).filter((p) => p.enrollment);

  const applyEnrolledPeople = useCallback(async () => {
    const dataDir = await getAppDataDir();
    if (!dataDir) return;
    const peopleRows = enrolledPeople.flatMap((person) =>
      (person.enrollment?.samples ?? []).map((sample) =>
        newRow(person.name, {
          kind: "library",
          path: `${dataDir}/people/${person.id}/${sample.path}`,
          name: sample.path.split("/").pop() ?? sample.path,
        }),
      ),
    );
    if (peopleRows.length > 0) setRows(peopleRows);
  }, [enrolledPeople]);

  const enrolled: EnrolledClip[] = rows
    .filter((row) => row.input && row.name.trim())
    .map((row) => ({ name: row.name.trim(), path: (row.input as BenchInput).path }));

  const identify = useCallback(async () => {
    if (!probe || enrolled.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setSelectedRunId(null);
    const startedAt = performance.now();
    try {
      const identified = await speakerIdentifyFile(probe.path, enrolled, {
        threshold: typeof params.threshold === "number" ? params.threshold : undefined,
      });
      setResult(identified);
      const persisted: IdentifyRunResult = { identify: identified, enrolled };
      await addRun({
        tool: TOOL,
        engineId: engine?.id ?? null,
        durationMs: Math.round(performance.now() - startedAt),
        input: probe,
        params,
        result: persisted,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [probe, enrolled, busy, params, engine, addRun]);

  const restoreRun = useCallback((saved: PlaygroundRun) => {
    const persisted = saved.result as IdentifyRunResult | null;
    if (saved.input.path) {
      setProbe({
        kind: "file",
        path: saved.input.path,
        name: saved.input.name ?? saved.input.path,
      });
    }
    if (persisted?.enrolled) {
      setRows(
        persisted.enrolled.map((clip) =>
          newRow(clip.name, {
            kind: "file",
            path: clip.path,
            name: clip.path.split("/").pop() ?? clip.path,
          }),
        ),
      );
    }
    setParams(saved.params);
    setResult(persisted?.identify ?? null);
    setError(null);
    setSelectedRunId(saved.id);
  }, []);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-xl">Speaker identification</h1>
          <p className="text-muted-foreground text-sm">
            Enroll named reference clips, then find who speaks in a probe clip.
          </p>
        </div>
        <EngineChip
          task="speakerId"
          override={engineOverride}
          onOverride={setEngineOverride}
        />
      </header>

      <ParamPanel specs={engine?.params ?? []} values={params} onChange={setParam} />

      {!isDesktop() && (
        <p className="text-muted-foreground text-sm">
          Speaker identification requires the desktop app.
        </p>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-sm">Enrolled speakers</h2>
          <div className="flex items-center gap-2">
            {enrolledPeople.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void applyEnrolledPeople()}
                disabled={busy}
                title="Load reference clips from enrolled People"
              >
                <UserCheck className="mr-1 h-4 w-4" /> Use enrolled People
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRows((prev) => [...prev, newRow()])}
              disabled={busy}
            >
              <Plus className="mr-1 h-4 w-4" /> Add speaker
            </Button>
          </div>
        </div>
        {rows.map((row) => (
          <div key={row.key} className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2">
              <Input
                value={row.name}
                onChange={(e) => updateRow(row.key, { name: e.target.value })}
                placeholder="Name"
                className="h-8 max-w-56"
                disabled={busy}
              />
              <span className="flex-1 truncate text-muted-foreground text-xs">
                {row.input?.name ?? "no clip yet"}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-muted-foreground"
                onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                disabled={busy || rows.length <= 1}
                aria-label={`Remove ${row.name || "speaker"}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <InputSourcePanel
              value={row.input}
              onChange={(input) => updateRow(row.key, { input })}
              disabled={busy}
            />
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-sm">Probe clip</h2>
          <Button
            size="sm"
            onClick={identify}
            disabled={!engine || busy || !probe || enrolled.length === 0 || !isDesktop()}
          >
            {busy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Users className="mr-1 h-4 w-4" />
            )}
            Identify
          </Button>
        </div>
        <InputSourcePanel value={probe} onChange={setProbe} disabled={busy} />
      </section>

      {error && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm">
          {error}
        </p>
      )}

      {result && <IdentifyResult result={result} />}

      <RecentRuns
        tool={TOOL}
        selectedId={selectedRunId}
        onSelect={restoreRun}
        summarize={(saved) => {
          const persisted = saved.result as IdentifyRunResult | null;
          if (!persisted) return "—";
          return persisted.identify.best
            ? `${persisted.identify.best} (${persisted.identify.scores[0]?.score.toFixed(2)})`
            : "no match";
        }}
      />
    </div>
  );
}

function IdentifyResult({ result }: { result: SpeakerIdentifyResult }) {
  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-4">
      <p className="font-medium text-sm">
        {result.best ? (
          <>
            Best match: <span className="text-primary">{result.best}</span>
          </>
        ) : (
          "No enrolled speaker cleared the threshold"
        )}
      </p>
      <ul className="space-y-1.5">
        {result.scores.map((score) => (
          <li key={score.name} className="flex items-center gap-2 text-xs">
            <span className="w-32 truncate">{score.name}</span>
            <div className="relative h-2 flex-1 rounded bg-muted">
              <div
                className={cn(
                  "absolute h-full rounded",
                  score.isMatch ? "bg-primary/70" : "bg-muted-foreground/40",
                )}
                style={{
                  width: `${Math.max(0, Math.min(((score.score + 1) / 2) * 100, 100))}%`,
                }}
              />
              <div
                className="absolute top-[-2px] h-3 w-0.5 bg-foreground/60"
                style={{ left: `${((result.threshold + 1) / 2) * 100}%` }}
              />
            </div>
            <span className="w-12 text-right tabular-nums">{score.score.toFixed(3)}</span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-xs">
        Threshold {result.threshold.toFixed(2)} · {result.processingMs.toFixed(0)} ms
      </p>
    </section>
  );
}
