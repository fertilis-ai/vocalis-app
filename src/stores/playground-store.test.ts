import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaygroundRun } from "@/lib/schemas/playground";

const mocks = vi.hoisted(() => ({
  listFiles: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deletePath: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({ ...mocks, isDesktop: () => true }));

import { MAX_RUNS_PER_TOOL } from "@/lib/schemas/playground";
import { usePlaygroundStore } from "./playground-store";

function makeRun(overrides: Partial<PlaygroundRun> = {}): PlaygroundRun {
  return {
    id: crypto.randomUUID(),
    tool: "vad",
    engineId: "local.silero-vad",
    createdAt: new Date().toISOString(),
    durationMs: 42,
    input: { kind: "file", path: "/tmp/a.wav", name: "a.wav" },
    params: { threshold: 0.5 },
    result: { segments: [] },
    ...overrides,
  };
}

function resetStore() {
  usePlaygroundStore.setState({ runs: {}, loaded: {} });
}

describe("playground-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.deletePath.mockResolvedValue(undefined);
  });

  it("loadRuns hydrates newest-first and skips invalid files", async () => {
    const older = makeRun({ createdAt: "2026-07-01T00:00:00.000Z" });
    const newer = makeRun({ createdAt: "2026-07-09T00:00:00.000Z" });
    mocks.listFiles.mockResolvedValue([older.id, newer.id, "corrupt"]);
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes(older.id)) return JSON.stringify(older);
      if (path.includes(newer.id)) return JSON.stringify(newer);
      return "not json";
    });

    await usePlaygroundStore.getState().loadRuns("vad");

    const runs = usePlaygroundStore.getState().runs.vad;
    expect(runs.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(mocks.listFiles).toHaveBeenCalledWith(
      "~/.vocalis/playground/vad/runs",
      "json",
    );
  });

  it("loadRuns only hits the disk once per tool", async () => {
    mocks.listFiles.mockResolvedValue([]);
    await usePlaygroundStore.getState().loadRuns("vad");
    await usePlaygroundStore.getState().loadRuns("vad");
    expect(mocks.listFiles).toHaveBeenCalledTimes(1);
  });

  it("addRun persists the run and prepends it", async () => {
    const run = await usePlaygroundStore.getState().addRun({
      tool: "punctuation",
      engineId: "local.ct-transformer",
      durationMs: 10,
      input: { kind: "text", text: "hello world" },
      params: {},
      result: { text: "Hello, world." },
    });

    expect(mocks.writeFile).toHaveBeenCalledWith(
      `~/.vocalis/playground/punctuation/runs/${run.id}.json`,
      expect.stringContaining(run.id),
    );
    expect(usePlaygroundStore.getState().runs.punctuation[0].id).toBe(run.id);
  });

  it("addRun evicts runs beyond the cap and deletes their files", async () => {
    const existing = Array.from({ length: MAX_RUNS_PER_TOOL }, (_, i) =>
      makeRun({ createdAt: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }),
    );
    usePlaygroundStore.setState({ runs: { vad: existing }, loaded: { vad: true } });

    await usePlaygroundStore.getState().addRun({
      tool: "vad",
      engineId: "local.silero-vad",
      durationMs: 5,
      input: { kind: "file", path: "/tmp/b.wav" },
      params: {},
      result: null,
    });

    const runs = usePlaygroundStore.getState().runs.vad;
    expect(runs).toHaveLength(MAX_RUNS_PER_TOOL);
    const evicted = existing[existing.length - 1];
    expect(runs.find((r) => r.id === evicted.id)).toBeUndefined();
    expect(mocks.deletePath).toHaveBeenCalledWith(
      `~/.vocalis/playground/vad/runs/${evicted.id}.json`,
    );
  });

  it("removeRun deletes the file and drops the entry", async () => {
    const run = makeRun();
    usePlaygroundStore.setState({ runs: { vad: [run] }, loaded: { vad: true } });

    await usePlaygroundStore.getState().removeRun("vad", run.id);

    expect(usePlaygroundStore.getState().runs.vad).toEqual([]);
    expect(mocks.deletePath).toHaveBeenCalledWith(
      `~/.vocalis/playground/vad/runs/${run.id}.json`,
    );
  });
});
