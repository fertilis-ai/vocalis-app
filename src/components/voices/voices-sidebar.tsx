import * as React from "react";
import { Plus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getUniqueName } from "@/lib/tree-utils";
import { cn } from "@/lib/utils";
import { usePeopleStore } from "@/stores/people-store";
import { useVoicesStore, type VoicesView } from "@/stores/voices-store";

// Sidebar for the Voices section (spec §2.4, two tabs): People — the
// enrolled-people list with color dot, avatar initial, enrollment badge —
// and the TTS voice library (M5 item 4). Selecting a person opens their
// profile + guided flows in the main pane.

function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

const TABS: { id: VoicesView; label: string }[] = [
  { id: "people", label: "People" },
  { id: "library", label: "Voices" },
];

export function VoicesSidebar() {
  const store = usePeopleStore();
  const view = useVoicesStore((s) => s.view);
  const setView = useVoicesStore((s) => s.setView);

  React.useEffect(() => {
    void store.loadAll();
  }, [store.loadAll]);

  const people = React.useMemo(
    () =>
      Object.values(store.people).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    [store.people],
  );

  async function addPerson() {
    const existing = people.map((p) => p.name);
    await store.create(getUniqueName("New person", existing));
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-2 pt-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setView(tab.id)}
            className={cn(
              "flex-1 rounded-md px-2 py-1 font-medium text-xs transition-colors",
              view === tab.id
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {view === "library" ? (
        <p className="px-3 py-4 text-muted-foreground text-xs">
          Stock, cloud, and cloned voices — with previews, favorites, and
          per-voice speed.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between px-3 py-2">
            <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              People
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="h-6 w-6"
              onClick={() => void addPerson()}
              aria-label="Add person"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto pb-2">
            {people.length === 0 ? (
          <div className="px-3 py-4 text-muted-foreground text-xs">
            <p className="mb-2">No people yet.</p>
            <Button variant="outline" size="sm" onClick={() => void addPerson()}>
              <UserPlus className="mr-1 h-4 w-4" /> Add person
            </Button>
          </div>
        ) : (
          people.map((person) => (
            <button
              key={person.id}
              type="button"
              onClick={() => store.select(person.id)}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                store.selectedId === person.id && "bg-secondary",
              )}
            >
              <span
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full font-medium text-[11px] text-white"
                style={{ backgroundColor: person.color }}
              >
                {initial(person.name)}
              </span>
              <span className="flex-1 truncate">{person.name}</span>
              <span
                className={cn(
                  "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                  person.enrollment ? "bg-emerald-500" : "bg-muted-foreground/40",
                )}
                aria-label={person.enrollment ? "Enrolled" : "Not enrolled"}
              />
            </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
