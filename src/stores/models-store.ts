import { create } from "zustand";
import {
  addCustomModel,
  cancelDownload,
  deleteModel,
  downloadModel,
  fetchCatalog,
  fetchInstalled,
} from "@/lib/engines/registry";
import type { Catalog, InstalledModel } from "@/lib/schemas/catalog";
import { useSettingsStore } from "@/stores/settings-store";

export interface DownloadProgress {
  received: number;
  total: number;
  phase: "downloading" | "extracting";
}

// Runtime-only state (catalog, disk scan, in-flight downloads) — nothing here
// is worth persisting; loadCatalog/loadInstalled rebuild it on mount.
interface ModelsState {
  catalog: Catalog | null;
  catalogError: string | null;
  installed: InstalledModel[];
  /** true once the disk has been scanned at least once this session */
  installedScanned: boolean;
  /** modelId -> live download progress */
  downloads: Record<string, DownloadProgress>;
  /** modelId -> last download error (cleared on retry) */
  errors: Record<string, string>;

  loadCatalog: () => Promise<void>;
  loadInstalled: () => Promise<void>;
  download: (modelId: string) => Promise<void>;
  cancel: (modelId: string) => Promise<void>;
  remove: (modelId: string) => Promise<void>;
  /** Import a local folder as a custom model; rejects with the load error. */
  addCustom: (args: {
    task: string;
    name: string;
    family: string | null;
    sourcePath: string;
  }) => Promise<void>;
}

export const useModelsStore = create<ModelsState>()((set, get) => ({
  catalog: null,
  catalogError: null,
  installed: [],
  installedScanned: false,
  downloads: {},
  errors: {},

  loadCatalog: async () => {
    try {
      set({ catalog: await fetchCatalog(), catalogError: null });
    } catch (err) {
      set({ catalogError: String(err) });
    }
  },

  loadInstalled: async () => {
    try {
      set({ installed: await fetchInstalled(), installedScanned: true });
    } catch (err) {
      console.warn("[models] Failed to scan installed models:", err);
    }
  },

  download: async (modelId) => {
    const { downloads, catalog } = get();
    if (downloads[modelId]) return;
    const catalogTotal =
      catalog?.models.find((m) => m.id === modelId)?.sizeBytes ?? 0;
    set((state) => {
      const { [modelId]: _cleared, ...errors } = state.errors;
      return {
        downloads: {
          ...state.downloads,
          [modelId]: { received: 0, total: catalogTotal, phase: "downloading" },
        },
        errors,
      };
    });

    await downloadModel(modelId, (event) => {
      switch (event.type) {
        case "progress":
          set((state) => ({
            downloads: {
              ...state.downloads,
              [modelId]: {
                received: event.received,
                total: event.total || catalogTotal,
                phase: "downloading",
              },
            },
          }));
          break;
        case "extracting":
          set((state) => {
            const current = state.downloads[modelId];
            if (!current) return state;
            return {
              downloads: {
                ...state.downloads,
                [modelId]: { ...current, phase: "extracting" },
              },
            };
          });
          break;
        case "done":
          set((state) => {
            const { [modelId]: _done, ...downloads } = state.downloads;
            return { downloads };
          });
          void get().loadInstalled();
          break;
        case "error":
          set((state) => {
            const { [modelId]: _failed, ...downloads } = state.downloads;
            return {
              downloads,
              errors: { ...state.errors, [modelId]: event.message },
            };
          });
          break;
      }
    });
  },

  cancel: async (modelId) => {
    try {
      await cancelDownload(modelId);
      // The backend answers with an Error("cancelled") event that clears
      // the downloads entry.
    } catch (err) {
      console.warn("[models] Failed to cancel download:", err);
    }
  },

  remove: async (modelId) => {
    const entry = get().installed.find((m) => m.id === modelId);
    if (!entry) return;
    try {
      await deleteModel(entry.task, modelId);
    } catch (err) {
      // The backend refuses deletion while a pipeline/engine holds the model
      // (spec §2.5) — surface it in the card rather than silently no-op'ing.
      set((state) => ({
        errors: { ...state.errors, [modelId]: String(err) },
      }));
      return;
    }
    set((state) => {
      const { [modelId]: _cleared, ...errors } = state.errors;
      return { errors };
    });
    useSettingsStore.getState().clearActiveModel(entry.task, modelId);
    await get().loadInstalled();
  },

  addCustom: async (args) => {
    // Errors (bad folder, failed load) propagate to the dialog to display.
    await addCustomModel(args);
    await get().loadInstalled();
  },
}));
