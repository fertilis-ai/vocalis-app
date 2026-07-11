import * as React from "react";
import { Check, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Person } from "@/lib/schemas/people";
import { usePeopleStore } from "@/stores/people-store";
import { EnrollmentFlow } from "./enrollment-flow";

// Main-pane view for one Person: editable name, color, enrollment status, and
// the guided enrollment flow. Deleting removes the whole people/<id>/ dir.

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function PersonDetail({ person }: { person: Person }) {
  const update = usePeopleStore((s) => s.update);
  const remove = usePeopleStore((s) => s.remove);
  // Keyed by person.id at the call site, so this state resets on selection.
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(person.name);

  async function commitName() {
    const name = draft.trim();
    if (name && name !== person.name) await update(person.id, { name });
    else setDraft(person.name);
    setEditing(false);
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex items-center gap-3">
        <span
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full font-medium text-sm text-white"
          style={{ backgroundColor: person.color }}
        >
          {person.name.trim().charAt(0).toUpperCase() || "?"}
        </span>

        {editing ? (
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitName();
              else if (e.key === "Escape") {
                setDraft(person.name);
                setEditing(false);
              }
            }}
            className="h-9 max-w-xs"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="group flex items-center gap-2 text-left"
          >
            <span className="font-semibold text-xl">{person.name}</span>
            <Pencil className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          {person.enrollment ? (
            <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-600 text-xs dark:text-emerald-400">
              <Check className="h-3.5 w-3.5" /> Enrolled
            </span>
          ) : (
            <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground text-xs">
              Not enrolled
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={() => void remove(person.id)}
            aria-label="Delete person"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {person.enrollment && (
        <p className="text-muted-foreground text-sm">
          Enrolled {formatDate(person.enrollment.enrolledAt)} from{" "}
          {person.enrollment.samples.length}{" "}
          {person.enrollment.samples.length === 1 ? "clip" : "clips"} ·{" "}
          {person.enrollment.embeddingDim}-dim voiceprint. This voice is matched
          automatically in transcription sessions.
        </p>
      )}

      <section>
        <h2 className="mb-3 font-medium text-sm">
          {person.enrollment ? "Re-record voice" : "Enroll voice"}
        </h2>
        <EnrollmentFlow person={person} />
      </section>
    </div>
  );
}
