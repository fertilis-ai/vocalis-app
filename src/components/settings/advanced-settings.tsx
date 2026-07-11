import { invoke } from "@tauri-apps/api/core";
import { Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { getAppDataDir, isDesktop } from "@/lib/storage";
import { SettingsSection } from "./settings-section";

export function AdvancedSettings() {
  const [dataDir, setDataDir] = useState("~/.vocalis");

  useEffect(() => {
    if (isDesktop()) {
      void getAppDataDir().then((dir) => {
        if (dir) setDataDir(dir);
      });
    }
  }, []);

  const reveal = (subdir?: string) => {
    void invoke("reveal_in_folder", {
      path: subdir ? `${dataDir}/${subdir}` : dataDir,
    }).catch((err) => console.warn("[settings] reveal failed:", err));
  };

  return (
    <SettingsSection icon={Wrench} id="advanced" last title="Advanced">
      <div className="space-y-4">
        <div>
          <span className="font-medium text-sm">App data</span>
          <p className="mt-1 text-muted-foreground text-sm">
            Everything Vocalis stores lives under{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">{dataDir}</code> —
            models, sessions, recordings, logs, and <code>config.yaml</code> (safe to
            hand-edit; changes are picked up live).
          </p>
          {isDesktop() && (
            <div className="mt-3 flex gap-2">
              <Button onClick={() => reveal()} size="sm" variant="outline">
                Reveal in Finder
              </Button>
              <Button onClick={() => reveal("logs")} size="sm" variant="outline">
                Open logs
              </Button>
            </div>
          )}
        </div>
        <p className="text-muted-foreground text-xs">
          The Debug pane (bottom of the icon bar) tails these logs live and will grow a
          pipeline inspector during M2.
        </p>
      </div>
    </SettingsSection>
  );
}
