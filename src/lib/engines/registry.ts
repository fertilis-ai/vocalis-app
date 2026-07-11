import { Channel, invoke } from "@tauri-apps/api/core";
import {
  type Catalog,
  catalogSchema,
  type InstalledModel,
} from "@/lib/schemas/catalog";
import { isDesktop } from "@/lib/storage";

// Bridge to the Rust model registry (src-tauri/src/commands/models.rs).
// Downloads happen entirely in Rust; only progress events cross the boundary.

export type DownloadEvent =
  | { type: "progress"; received: number; total: number }
  | { type: "extracting" }
  | { type: "done" }
  | { type: "error"; message: string };

const EMPTY_CATALOG: Catalog = { version: 0, models: [] };

export async function fetchCatalog(): Promise<Catalog> {
  if (!isDesktop()) return EMPTY_CATALOG;
  const raw = await invoke("models_catalog");
  return catalogSchema.parse(raw);
}

export async function fetchInstalled(): Promise<InstalledModel[]> {
  if (!isDesktop()) return [];
  return invoke<InstalledModel[]>("models_installed");
}

/**
 * Start a download; resolves when the download finishes (or fails). All
 * outcomes — including failures — arrive as events, so callers only need
 * onEvent.
 */
export async function downloadModel(
  modelId: string,
  onEvent: (event: DownloadEvent) => void,
): Promise<void> {
  if (!isDesktop()) {
    onEvent({ type: "error", message: "Model downloads require the desktop app" });
    return;
  }
  const channel = new Channel<DownloadEvent>();
  channel.onmessage = onEvent;
  try {
    await invoke("model_download", { channel, modelId });
  } catch (err) {
    // Pre-flight rejections (unknown id, already downloading) — the backend
    // never emitted an event for these.
    onEvent({ type: "error", message: String(err) });
  }
}

export async function cancelDownload(modelId: string): Promise<void> {
  if (!isDesktop()) return;
  await invoke("model_download_cancel", { modelId });
}

export async function deleteModel(task: string, modelId: string): Promise<void> {
  if (!isDesktop()) return;
  await invoke("model_delete", { task, modelId });
}

/**
 * Import a local folder as a custom model. Rust copies it into the models
 * store, validates it loads for the task, and marks it custom (spec §2.5).
 * Rejects (with the load error) if the folder isn't a usable model.
 */
export async function addCustomModel(args: {
  task: string;
  name: string;
  family: string | null;
  sourcePath: string;
}): Promise<InstalledModel> {
  if (!isDesktop()) throw new Error("Adding models requires the desktop app");
  return invoke<InstalledModel>("model_add_custom", {
    task: args.task,
    name: args.name,
    family: args.family,
    sourcePath: args.sourcePath,
  });
}
