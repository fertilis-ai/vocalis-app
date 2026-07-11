import { useNavigate, useSearch } from "@tanstack/react-router";
import { LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";
import { useModelsStore } from "@/stores/models-store";
import { orderTasks, TASK_META, taskLabel } from "./task-meta";

export function ModelsSidebar() {
  const navigate = useNavigate();
  const { task: activeTask } = useSearch({ from: "/models" });
  const catalog = useModelsStore((state) => state.catalog);

  const tasks = orderTasks((catalog?.models ?? []).map((m) => m.task));
  const items = [
    { id: "all", label: "All models", icon: LayoutGrid },
    ...tasks.map((task) => ({
      id: task,
      label: taskLabel(task),
      icon: TASK_META[task]?.icon ?? LayoutGrid,
    })),
  ];

  return (
    <div className="flex h-full flex-col gap-0.5 overflow-y-auto p-2">
      <span className="px-2 py-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Catalog
      </span>
      {items.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => navigate({ to: "/models", search: { task: id } })}
          className={cn(
            "flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
            activeTask === id
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
          )}
        >
          <Icon className="h-4 w-4 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      ))}
    </div>
  );
}
