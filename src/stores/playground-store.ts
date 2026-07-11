import { v4 as uuid } from "uuid";
import { create } from "zustand";
import {
  MAX_RUNS_PER_TOOL,
  type PlaygroundRun,
  playgroundRunSchema,
  type RunInput,
} from "@/lib/schemas/playground";
import { deletePath, listFiles, readFile, writeFile } from "@/lib/storage";

// Recent bench runs per tool (spec §2.3), persisted one JSON file per run at
// ~/.vocalis/playground/<tool>/runs/<id>.json. State is a mirror of disk:
// loadRuns() hydrates a tool once per session; addRun/removeRun write through.

function runsDir(tool: string): string {
  return `~/.vocalis/playground/${tool}/runs`;
}

function runPath(run: Pick<PlaygroundRun, "tool" | "id">): string {
  return `${runsDir(run.tool)}/${run.id}.json`;
}

export interface NewRun {
  tool: string;
  engineId: string | null;
  durationMs: number;
  input: RunInput;
  params: Record<string, unknown>;
  result: unknown;
}

interface PlaygroundState {
  /** tool id → newest-first recent runs */
  runs: Record<string, PlaygroundRun[]>;
  /** tool ids hydrated from disk this session */
  loaded: Record<string, boolean>;

  loadRuns: (tool: string) => Promise<void>;
  addRun: (run: NewRun) => Promise<PlaygroundRun>;
  removeRun: (tool: string, id: string) => Promise<void>;
}

export const usePlaygroundStore = create<PlaygroundState>()((set, get) => ({
  runs: {},
  loaded: {},

  loadRuns: async (tool) => {
    if (get().loaded[tool]) return;
    set((state) => ({ loaded: { ...state.loaded, [tool]: true } }));

    // list_files returns file stems — for runs the stem is the run id.
    const ids = await listFiles(runsDir(tool), "json");
    const runs: PlaygroundRun[] = [];
    for (const id of ids) {
      const path = `${runsDir(tool)}/${id}.json`;
      try {
        const parsed = playgroundRunSchema.parse(JSON.parse(await readFile(path)));
        runs.push(parsed);
      } catch (err) {
        console.warn(`[playground] skipping unreadable run ${path}:`, err);
      }
    }
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    set((state) => ({
      runs: { ...state.runs, [tool]: runs.slice(0, MAX_RUNS_PER_TOOL) },
    }));
  },

  addRun: async (newRun) => {
    const run: PlaygroundRun = {
      ...newRun,
      id: uuid(),
      createdAt: new Date().toISOString(),
    };
    await writeFile(runPath(run), JSON.stringify(run, null, 2));

    const current = get().runs[run.tool] ?? [];
    const kept = [run, ...current].slice(0, MAX_RUNS_PER_TOOL);
    for (const evicted of [run, ...current].slice(MAX_RUNS_PER_TOOL)) {
      void deletePath(runPath(evicted)).catch(() => {});
    }
    set((state) => ({ runs: { ...state.runs, [run.tool]: kept } }));
    return run;
  },

  removeRun: async (tool, id) => {
    await deletePath(`${runsDir(tool)}/${id}.json`);
    set((state) => ({
      runs: {
        ...state.runs,
        [tool]: (state.runs[tool] ?? []).filter((run) => run.id !== id),
      },
    }));
  },
}));
