import { Link } from "@tanstack/react-router";
import { HardDrive } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatBytes, taskLabel } from "@/components/models/task-meta";
import { Input } from "@/components/ui/input";
import { ttsCacheSize } from "@/lib/engines/local";
import { isDesktop } from "@/lib/storage";
import { useModelsStore } from "@/stores/models-store";
import { useSettingsStore } from "@/stores/settings-store";
import { SettingsSection } from "./settings-section";

const BYTES_PER_GB = 1024 * 1024 * 1024;

export function ModelsSettings() {
  const installed = useModelsStore((s) => s.installed);
  const installedScanned = useModelsStore((s) => s.installedScanned);
  const loadInstalled = useModelsStore((s) => s.loadInstalled);
  const ttsCacheMaxBytes = useSettingsStore((s) => s.ttsCacheMaxBytes);
  const setTtsCacheMaxBytes = useSettingsStore((s) => s.setTtsCacheMaxBytes);
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);

  useEffect(() => {
    if (!installedScanned) void loadInstalled();
  }, [installedScanned, loadInstalled]);

  useEffect(() => {
    if (!isDesktop()) return;
    void ttsCacheSize().then(setCacheBytes);
  }, []);

  const byTask = useMemo(() => {
    const totals = new Map<string, number>();
    for (const model of installed) {
      totals.set(model.task, (totals.get(model.task) ?? 0) + model.sizeBytes);
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  }, [installed]);
  const total = installed.reduce((sum, model) => sum + model.sizeBytes, 0);

  return (
    <SettingsSection icon={HardDrive} id="models" title="Models & Storage">
      <div className="space-y-6">
        <div>
          <div className="flex items-baseline justify-between">
            <span className="font-medium text-sm">
              {installed.length} installed model{installed.length === 1 ? "" : "s"} ·{" "}
              {formatBytes(total)}
            </span>
            <Link
              className="text-primary text-sm hover:underline"
              search={{ task: "all" }}
              to="/models"
            >
              Manage models →
            </Link>
          </div>
          {byTask.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {byTask.map(([task, bytes]) => (
                <div className="flex items-center justify-between text-sm" key={task}>
                  <span className="text-muted-foreground">{taskLabel(task)}</span>
                  <span>{formatBytes(bytes)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <label className="font-medium text-sm" htmlFor="tts-cache-cap">
            Synthesized-audio cache limit
          </label>
          <div className="mt-2 flex items-center gap-2">
            <Input
              className="w-24"
              id="tts-cache-cap"
              min={1}
              onChange={(event) => {
                const gb = Number(event.target.value);
                if (Number.isFinite(gb) && gb >= 1) {
                  setTtsCacheMaxBytes(Math.round(gb * BYTES_PER_GB));
                }
              }}
              step={1}
              type="number"
              value={Math.round(ttsCacheMaxBytes / BYTES_PER_GB)}
            />
            <span className="text-muted-foreground text-sm">GB</span>
          </div>
          <p className="mt-2 text-muted-foreground text-xs">
            Oldest synthesized audio is evicted first once the cache exceeds this size.
            {cacheBytes !== null && (
              <>
                {" "}
                Currently using{" "}
                <span className="text-foreground">{formatBytes(cacheBytes)}</span>.
              </>
            )}
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}
