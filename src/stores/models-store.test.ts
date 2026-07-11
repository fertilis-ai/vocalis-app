import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadEvent } from "@/lib/engines/registry";
import type { Catalog } from "@/lib/schemas/catalog";

const mocks = vi.hoisted(() => ({
  fetchCatalog: vi.fn(),
  fetchInstalled: vi.fn(),
  downloadModel: vi.fn(),
  cancelDownload: vi.fn(),
  deleteModel: vi.fn(),
  addCustomModel: vi.fn(),
}));

vi.mock("@/lib/engines/registry", () => mocks);

// Mock zustand persist to be a passthrough (avoids localStorage issues in
// tests) — remove() clears the active slot in the persisted settings store.
vi.mock("zustand/middleware", () => ({
  persist: (fn: unknown) => fn,
}));

import { useModelsStore } from "./models-store";

const catalog: Catalog = {
  version: 1,
  models: [
    {
      id: "piper-fr-siwis",
      task: "tts",
      name: "Piper FR",
      description: "French voice",
      languages: ["fr"],
      sizeBytes: 1000,
      quantization: null,
      license: "MIT",
      url: "https://example.com/piper.tar.bz2",
      sha256: null,
      archive: "tar.bz2",
      recommended: false,
    },
  ],
};

function resetStore() {
  useModelsStore.setState({
    catalog: null,
    catalogError: null,
    installed: [],
    downloads: {},
    errors: {},
  });
}

describe("models-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    mocks.fetchInstalled.mockResolvedValue([]);
  });

  it("loadCatalog stores the catalog", async () => {
    mocks.fetchCatalog.mockResolvedValue(catalog);
    await useModelsStore.getState().loadCatalog();
    expect(useModelsStore.getState().catalog).toEqual(catalog);
    expect(useModelsStore.getState().catalogError).toBeNull();
  });

  it("loadCatalog records failures without throwing", async () => {
    mocks.fetchCatalog.mockRejectedValue(new Error("boom"));
    await useModelsStore.getState().loadCatalog();
    expect(useModelsStore.getState().catalog).toBeNull();
    expect(useModelsStore.getState().catalogError).toContain("boom");
  });

  it("loadInstalled stores the disk scan", async () => {
    mocks.fetchInstalled.mockResolvedValue([
      { task: "vad", id: "silero-vad-v5", sizeBytes: 643854 },
    ]);
    await useModelsStore.getState().loadInstalled();
    expect(useModelsStore.getState().installed).toHaveLength(1);
  });

  it("download tracks progress, extraction, and completion", async () => {
    useModelsStore.setState({ catalog });
    let emit: (event: DownloadEvent) => void = () => {};
    mocks.downloadModel.mockImplementation(
      async (_id: string, onEvent: typeof emit) => {
        emit = onEvent;
      },
    );

    await useModelsStore.getState().download("piper-fr-siwis");
    // Seeded from the catalog size before any event arrives.
    expect(useModelsStore.getState().downloads["piper-fr-siwis"]).toEqual({
      received: 0,
      total: 1000,
      phase: "downloading",
    });

    emit({ type: "progress", received: 500, total: 1000 });
    expect(
      useModelsStore.getState().downloads["piper-fr-siwis"]?.received,
    ).toBe(500);

    emit({ type: "extracting" });
    expect(useModelsStore.getState().downloads["piper-fr-siwis"]?.phase).toBe(
      "extracting",
    );

    mocks.fetchInstalled.mockResolvedValue([
      { task: "tts", id: "piper-fr-siwis", sizeBytes: 900 },
    ]);
    emit({ type: "done" });
    expect(
      useModelsStore.getState().downloads["piper-fr-siwis"],
    ).toBeUndefined();
    await vi.waitFor(() => {
      expect(useModelsStore.getState().installed).toHaveLength(1);
    });
  });

  it("download failure lands in errors and retry clears it", async () => {
    useModelsStore.setState({ catalog });
    mocks.downloadModel.mockImplementation(
      async (_id: string, onEvent: (event: DownloadEvent) => void) => {
        onEvent({ type: "error", message: "network down" });
      },
    );
    await useModelsStore.getState().download("piper-fr-siwis");
    expect(useModelsStore.getState().errors["piper-fr-siwis"]).toBe(
      "network down",
    );
    expect(
      useModelsStore.getState().downloads["piper-fr-siwis"],
    ).toBeUndefined();

    mocks.downloadModel.mockImplementation(async () => {});
    await useModelsStore.getState().download("piper-fr-siwis");
    expect(
      useModelsStore.getState().errors["piper-fr-siwis"],
    ).toBeUndefined();
  });

  it("ignores a second download of the same model", async () => {
    useModelsStore.setState({
      catalog,
      downloads: {
        "piper-fr-siwis": { received: 1, total: 1000, phase: "downloading" },
      },
    });
    await useModelsStore.getState().download("piper-fr-siwis");
    expect(mocks.downloadModel).not.toHaveBeenCalled();
  });

  it("cancel forwards to the backend", async () => {
    await useModelsStore.getState().cancel("piper-fr-siwis");
    expect(mocks.cancelDownload).toHaveBeenCalledWith("piper-fr-siwis");
  });

  it("remove deletes by installed task and rescans", async () => {
    useModelsStore.setState({
      installed: [{ task: "tts", id: "piper-fr-siwis", sizeBytes: 900 }],
    });
    mocks.deleteModel.mockResolvedValue(undefined);
    await useModelsStore.getState().remove("piper-fr-siwis");
    expect(mocks.deleteModel).toHaveBeenCalledWith("tts", "piper-fr-siwis");
    expect(mocks.fetchInstalled).toHaveBeenCalled();
  });

  it("remove clears the active slot when the deleted model held it", async () => {
    const { useSettingsStore } = await import("@/stores/settings-store");
    useSettingsStore.setState({ activeByTask: { tts: "piper-fr-siwis" } });
    useModelsStore.setState({
      installed: [{ task: "tts", id: "piper-fr-siwis", sizeBytes: 900 }],
    });
    mocks.deleteModel.mockResolvedValue(undefined);
    await useModelsStore.getState().remove("piper-fr-siwis");
    expect(useSettingsStore.getState().activeByTask.tts).toBeUndefined();
  });

  it("remove of a model that is not installed is a no-op", async () => {
    await useModelsStore.getState().remove("ghost");
    expect(mocks.deleteModel).not.toHaveBeenCalled();
  });

  it("remove surfaces an in-use rejection and skips the rescan", async () => {
    const { useSettingsStore } = await import("@/stores/settings-store");
    useSettingsStore.setState({ activeByTask: { tts: "piper-fr-siwis" } });
    useModelsStore.setState({
      installed: [{ task: "tts", id: "piper-fr-siwis", sizeBytes: 900 }],
    });
    mocks.deleteModel.mockRejectedValue("piper-fr-siwis is in use");
    await useModelsStore.getState().remove("piper-fr-siwis");
    expect(useModelsStore.getState().errors["piper-fr-siwis"]).toContain(
      "in use",
    );
    // Active slot untouched and no disk rescan on a refused delete.
    expect(useSettingsStore.getState().activeByTask.tts).toBe("piper-fr-siwis");
    expect(mocks.fetchInstalled).not.toHaveBeenCalled();
  });

  it("addCustom forwards to the bridge and rescans on success", async () => {
    mocks.addCustomModel.mockResolvedValue({
      task: "tts",
      id: "custom-my-voice",
      sizeBytes: 42,
      custom: true,
      name: "My Voice",
    });
    await useModelsStore.getState().addCustom({
      task: "tts",
      name: "My Voice",
      family: null,
      sourcePath: "/some/folder",
    });
    expect(mocks.addCustomModel).toHaveBeenCalledWith({
      task: "tts",
      name: "My Voice",
      family: null,
      sourcePath: "/some/folder",
    });
    expect(mocks.fetchInstalled).toHaveBeenCalled();
  });

  it("addCustom propagates a validation failure to the caller", async () => {
    mocks.addCustomModel.mockRejectedValue("model failed to load as tts");
    await expect(
      useModelsStore.getState().addCustom({
        task: "tts",
        name: "Bad",
        family: null,
        sourcePath: "/bad",
      }),
    ).rejects.toBe("model failed to load as tts");
  });
});
