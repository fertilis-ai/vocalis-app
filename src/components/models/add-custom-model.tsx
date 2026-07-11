import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Loader2, Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isDesktop } from "@/lib/storage";
import { useModelsStore } from "@/stores/models-store";
import { orderTasks, TASK_META, taskLabel } from "./task-meta";

// clone-tts has no engine yet (M5), so it can't be load-validated — exclude it.
const CUSTOM_TASKS = orderTasks(Object.keys(TASK_META)).filter(
  (task) => task !== "clone-tts",
);

/**
 * The "custom escape hatch" (spec §2.5): import a local model folder, choose
 * its task, and let Rust validate it loads before it joins the models store.
 * Renders as a button that expands into an inline form.
 */
export function AddCustomModel() {
  const addCustom = useModelsStore((s) => s.addCustom);
  const [expanded, setExpanded] = useState(false);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [task, setTask] = useState(CUSTOM_TASKS[0]);
  const [family, setFamily] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adding models copies a folder into ~/.vocalis and loads an engine — desktop
  // only; there's nothing to do in the plain-browser dev harness.
  if (!isDesktop()) return null;

  function close() {
    setExpanded(false);
    setSourcePath(null);
    setName("");
    setTask(CUSTOM_TASKS[0]);
    setFamily("");
    setError(null);
    setBusy(false);
  }

  async function pickFolder() {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setSourcePath(picked);
      // Seed the name from the folder if the user hasn't typed one.
      if (!name.trim()) setName(picked.split("/").pop() ?? "");
    }
  }

  async function submit() {
    if (!sourcePath || !name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await addCustom({
        task,
        name: name.trim(),
        family: family.trim() || null,
        sourcePath,
      });
      close();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  if (!expanded) {
    return (
      <Button variant="outline" size="sm" onClick={() => setExpanded(true)}>
        <Plus className="mr-1 h-4 w-4" /> Add custom model
      </Button>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-sm">Add a custom model</h2>
        <Button
          size="sm"
          variant="ghost"
          onClick={close}
          disabled={busy}
          aria-label="Cancel"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Model folder</Label>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={pickFolder} disabled={busy}>
            <FolderOpen className="mr-1 h-4 w-4" /> Choose folder…
          </Button>
          <span className="truncate text-muted-foreground text-xs">
            {sourcePath ?? "No folder selected"}
          </span>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="custom-name">Name</Label>
          <Input
            id="custom-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My model"
            disabled={busy}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="custom-task">Task</Label>
          <select
            id="custom-task"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            disabled={busy}
            className="h-8 rounded-md border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {CUSTOM_TASKS.map((t) => (
              <option key={t} value={t}>
                {taskLabel(t)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="custom-family">Family (optional)</Label>
        <Input
          id="custom-family"
          value={family}
          onChange={(e) => setFamily(e.target.value)}
          placeholder="e.g. kokoro, whisper — informational"
          disabled={busy}
        />
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={submit}
          disabled={busy || !sourcePath || !name.trim()}
        >
          {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          {busy ? "Validating…" : "Add model"}
        </Button>
        <span className="text-muted-foreground text-xs">
          The folder is copied into ~/.vocalis/models and loaded to verify it works.
        </span>
      </div>
    </section>
  );
}
