import { useState } from "react";
import { cn } from "@/lib/utils";
import { SETTINGS_SECTIONS, type SettingsSectionId, sectionAnchor } from "./sections";

export function SettingsSidebar() {
  const [active, setActive] = useState<SettingsSectionId>(SETTINGS_SECTIONS[0].id);

  const jumpTo = (id: SettingsSectionId) => {
    setActive(id);
    document.getElementById(sectionAnchor(id))?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="flex h-full flex-col gap-0.5 overflow-y-auto p-2">
      <span className="px-2 py-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Settings
      </span>
      {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => jumpTo(id)}
          className={cn(
            "flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
            active === id
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
