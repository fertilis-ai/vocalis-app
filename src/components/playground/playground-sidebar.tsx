import { useNavigate, useSearch } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { PLAYGROUND_TOOLS } from "./tools";

export function PlaygroundSidebar() {
  const navigate = useNavigate();
  const { tool: activeTool } = useSearch({ from: "/playground" });

  return (
    <div className="flex h-full flex-col gap-0.5 overflow-y-auto p-2">
      <span className="px-2 py-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Capabilities
      </span>
      {PLAYGROUND_TOOLS.map(({ id, label, icon: Icon, available }) => (
        <button
          key={id}
          type="button"
          onClick={() =>
            navigate({ to: "/playground", search: { tool: id } })
          }
          className={cn(
            "flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
            activeTool === id
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
            !available && "opacity-60",
          )}
        >
          <Icon className="h-4 w-4 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      ))}
    </div>
  );
}
