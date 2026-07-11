import { Trash2 } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import type { PlaygroundRun } from "@/lib/schemas/playground";
import { cn } from "@/lib/utils";
import { usePlaygroundStore } from "@/stores/playground-store";

// Persisted recent runs for one tool (spec §2.3). Selecting a run lets the
// page restore its params/input/result; the store owns disk truth.

interface RecentRunsProps {
  tool: string;
  /** One-line description of a run's result, task-shaped per tool. */
  summarize: (run: PlaygroundRun) => ReactNode;
  onSelect?: (run: PlaygroundRun) => void;
  selectedId?: string | null;
  className?: string;
}

function timeLabel(iso: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function RecentRuns({
  tool,
  summarize,
  onSelect,
  selectedId,
  className,
}: RecentRunsProps) {
  const runs = usePlaygroundStore((s) => s.runs[tool]);
  const loadRuns = usePlaygroundStore((s) => s.loadRuns);
  const removeRun = usePlaygroundStore((s) => s.removeRun);

  useEffect(() => {
    void loadRuns(tool);
  }, [loadRuns, tool]);

  if (!runs || runs.length === 0) return null;

  return (
    <section className={className}>
      <h2 className="mb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Recent runs
      </h2>
      <ul className="space-y-0.5">
        {runs.map((run) => (
          <li key={run.id} className="group flex items-center gap-1">
            <button
              type="button"
              onClick={() => onSelect?.(run)}
              className={cn(
                "flex min-w-0 flex-1 items-baseline gap-2 rounded px-2 py-1 text-left text-xs transition-colors hover:bg-accent",
                selectedId === run.id && "bg-secondary",
              )}
            >
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {timeLabel(run.createdAt)}
              </span>
              <span className="min-w-0 flex-1 truncate">{summarize(run)}</span>
              {run.input.name && (
                <span className="max-w-32 shrink-0 truncate text-muted-foreground">
                  {run.input.name}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => removeRun(tool, run.id)}
              aria-label="Delete run"
              className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-destructive group-hover:opacity-100"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
