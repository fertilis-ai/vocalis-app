import { useSearch } from "@tanstack/react-router";
import {
  BadgeCheck,
  Check,
  Download,
  HardDrive,
  Loader2,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ttsCacheSize } from "@/lib/engines/local";
import type { CatalogModel, InstalledModel } from "@/lib/schemas/catalog";
import { cn } from "@/lib/utils";
import { type DownloadProgress, useModelsStore } from "@/stores/models-store";
import { useSettingsStore } from "@/stores/settings-store";
import { AddCustomModel } from "./add-custom-model";
import { formatBytes, orderTasks, TASK_META, taskLabel } from "./task-meta";

export function ModelsView() {
  const { task: activeTask } = useSearch({ from: "/models" });
  const catalog = useModelsStore((state) => state.catalog);
  const catalogError = useModelsStore((state) => state.catalogError);
  const installed = useModelsStore((state) => state.installed);
  const loadCatalog = useModelsStore((state) => state.loadCatalog);
  const loadInstalled = useModelsStore((state) => state.loadInstalled);

  const [cacheBytes, setCacheBytes] = useState(0);

  useEffect(() => {
    void loadCatalog();
    void loadInstalled();
    void ttsCacheSize().then(setCacheBytes);
  }, [loadCatalog, loadInstalled]);

  const models = catalog?.models ?? [];
  const tasks = orderTasks(models.map((m) => m.task)).filter(
    (task) => activeTask === "all" || task === activeTask,
  );
  const modelsBytes = installed.reduce((sum, m) => sum + m.sizeBytes, 0);
  const totalBytes = modelsBytes + cacheBytes;
  // Per-task on-disk totals for the section headers.
  const bytesByTask = installed.reduce<Record<string, number>>((acc, m) => {
    acc[m.task] = (acc[m.task] ?? 0) + m.sizeBytes;
    return acc;
  }, {});

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
        <header className="flex items-end justify-between gap-4">
          <div>
            <h1 className="font-semibold text-xl">Models</h1>
            <p className="text-muted-foreground text-sm">
              Curated sherpa-onnx models, downloaded into ~/.vocalis/models.
            </p>
          </div>
          <span
            className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-muted-foreground text-xs"
            title={`${formatBytes(modelsBytes)} models · ${formatBytes(cacheBytes)} TTS cache`}
          >
            <HardDrive className="h-3.5 w-3.5" />
            {formatBytes(totalBytes)} on disk · {installed.length} installed
          </span>
        </header>

        <AddCustomModel />

        {catalogError && (
          <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm">
            Failed to load the model catalog: {catalogError}
          </p>
        )}

        {tasks.map((task) => (
          <TaskSection
            key={task}
            task={task}
            models={models.filter((m) => m.task === task)}
            installed={installed}
            taskBytes={bytesByTask[task] ?? 0}
          />
        ))}

        {!catalogError && tasks.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {models.length === 0
              ? "Loading catalog…"
              : "No models in the catalog for this task."}
          </p>
        )}
      </div>
    </div>
  );
}

function TaskSection({
  task,
  models,
  installed,
  taskBytes,
}: {
  task: string;
  models: CatalogModel[];
  installed: InstalledModel[];
  taskBytes: number;
}) {
  const Icon = TASK_META[task]?.icon;
  const taskHasInstall = installed.some((m) => m.task === task);
  // User-added models have no catalog entry, so render them from the install
  // scan (spec §2.5).
  const customEntries = installed.filter((m) => m.task === task && m.custom);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 font-medium text-muted-foreground text-sm uppercase tracking-wide">
        {Icon && <Icon className="h-4 w-4" />}
        {taskLabel(task)}
        {taskBytes > 0 && (
          <span className="ml-auto font-normal normal-case tracking-normal">
            {formatBytes(taskBytes)}
          </span>
        )}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {models.map((model) => (
          <ModelCard
            key={model.id}
            model={model}
            installedEntry={installed.find(
              (m) => m.task === model.task && m.id === model.id,
            )}
            taskHasInstall={taskHasInstall}
          />
        ))}
        {customEntries.map((entry) => (
          <CustomModelCard key={entry.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}

/**
 * A user-added model (spec §2.5). Unlike catalog models it's always installed
 * and carries no catalog metadata, so the card is minimal: name, Custom badge,
 * size, and the same set-active / delete controls.
 */
function CustomModelCard({ entry }: { entry: InstalledModel }) {
  const error = useModelsStore((state) => state.errors[entry.id]);
  const remove = useModelsStore((state) => state.remove);
  const activeId = useSettingsStore((state) => state.activeByTask[entry.task]);
  const setActiveModel = useSettingsStore((state) => state.setActiveModel);
  const isActive = activeId === entry.id;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border p-4",
        isActive && "border-primary/50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-sm">{entry.name ?? entry.id}</span>
        <span className="flex shrink-0 items-center gap-1">
          <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
            Custom
          </span>
          {isActive && (
            <span className="rounded-full bg-primary px-2 py-0.5 text-primary-foreground text-xs">
              Active
            </span>
          )}
        </span>
      </div>

      <div className="mt-1 flex items-center gap-2">
        <span className="flex items-center gap-1 text-muted-foreground text-xs">
          <Check className="h-3.5 w-3.5 text-primary" />
          Installed · {formatBytes(entry.sizeBytes)}
        </span>
        <span className="flex-1" />
        {!isActive && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setActiveModel(entry.task, entry.id)}
          >
            Set active
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (window.confirm(`Delete ${entry.name ?? entry.id} from disk?`)) {
              void remove(entry.id);
            }
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

function ModelCard({
  model,
  installedEntry,
  taskHasInstall,
}: {
  model: CatalogModel;
  installedEntry?: InstalledModel;
  taskHasInstall: boolean;
}) {
  const progress = useModelsStore((state) => state.downloads[model.id]);
  const error = useModelsStore((state) => state.errors[model.id]);
  const download = useModelsStore((state) => state.download);
  const cancel = useModelsStore((state) => state.cancel);
  const remove = useModelsStore((state) => state.remove);
  const activeId = useSettingsStore((state) => state.activeByTask[model.task]);
  const setActiveModel = useSettingsStore((state) => state.setActiveModel);

  const isActive = installedEntry != null && activeId === model.id;

  const meta = [
    model.languages.length > 0 ? model.languages.join(", ").toUpperCase() : null,
    formatBytes(model.sizeBytes),
    model.quantization,
    model.license,
  ].filter(Boolean);

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border p-4",
        isActive && "border-primary/50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-sm">{model.name}</span>
        <span className="flex shrink-0 items-center gap-1">
          {model.recommended && (
            <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary text-xs">
              <BadgeCheck className="h-3 w-3" /> Recommended
            </span>
          )}
          {isActive && (
            <span className="rounded-full bg-primary px-2 py-0.5 text-primary-foreground text-xs">
              Active
            </span>
          )}
        </span>
      </div>

      <p className="text-muted-foreground text-sm">{model.description}</p>
      <p className="text-muted-foreground text-xs">{meta.join(" · ")}</p>

      {progress ? (
        <DownloadRow
          progress={progress}
          onCancel={() => void cancel(model.id)}
        />
      ) : installedEntry ? (
        <div className="mt-1 flex items-center gap-2">
          <span className="flex items-center gap-1 text-muted-foreground text-xs">
            <Check className="h-3.5 w-3.5 text-primary" />
            Installed · {formatBytes(installedEntry.sizeBytes)}
          </span>
          <span className="flex-1" />
          {!isActive && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setActiveModel(model.task, model.id)}
            >
              Set active
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (window.confirm(`Delete ${model.name} from disk?`)) {
                void remove(model.id);
              }
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-2">
          <Button size="sm" onClick={() => void download(model.id)}>
            <Download className="mr-1 h-4 w-4" /> Install
          </Button>
          {!taskHasInstall && (
            <span className="text-muted-foreground text-xs">
              No model installed yet — used for{" "}
              {taskLabel(model.task).toLowerCase()}.
            </span>
          )}
        </div>
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

function DownloadRow({
  progress,
  onCancel,
}: {
  progress: DownloadProgress;
  onCancel: () => void;
}) {
  const extracting = progress.phase === "extracting";
  const percent =
    progress.total > 0
      ? Math.min(100, (progress.received / progress.total) * 100)
      : 0;

  return (
    <div className="mt-1 flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full bg-primary transition-[width]",
            extracting && "animate-pulse",
          )}
          style={{ width: extracting ? "100%" : `${percent}%` }}
        />
      </div>
      <span className="w-24 text-right text-muted-foreground text-xs">
        {extracting ? (
          <span className="inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" /> Extracting…
          </span>
        ) : (
          `${formatBytes(progress.received)}${
            progress.total > 0 ? ` / ${formatBytes(progress.total)}` : ""
          }`
        )}
      </span>
      {!extracting && (
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
