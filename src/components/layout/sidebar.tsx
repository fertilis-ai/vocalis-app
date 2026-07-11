import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  AudioLines,
  Bug,
  FlaskConical,
  MessageSquare,
  Package,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { type SectionId, useLayoutStore } from "@/stores/layout-store";

const navItems = [
  {
    to: "/chat",
    section: "chat" as SectionId,
    icon: MessageSquare,
    label: "Chat",
  },
  {
    to: "/playground",
    section: "playground" as SectionId,
    icon: FlaskConical,
    label: "Playground",
  },
  {
    to: "/voices",
    section: "voices" as SectionId,
    icon: AudioLines,
    label: "Voices",
  },
  {
    to: "/models",
    section: "models" as SectionId,
    icon: Package,
    label: "Models",
  },
] as const;

const bottomItems = [
  { to: "/debug", section: "debug" as SectionId, icon: Bug, label: "Debug" },
  {
    to: "/settings",
    section: "settings" as SectionId,
    icon: Settings,
    label: "Settings",
  },
] as const;

function IconButton({
  to,
  section,
  icon: Icon,
  label,
}: {
  to: string;
  section: SectionId;
  icon: typeof MessageSquare;
  label: string;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { openSection, toggleSection, openSectionPane } = useLayoutStore();

  const isActive = location.pathname.startsWith(to);
  const isPaneOpen = openSection === section;

  const handleClick = () => {
    if (!isActive) {
      // Not on route: navigate + open pane
      navigate({ to });
      openSectionPane(section);
    } else {
      // On route: toggle pane
      toggleSection(section);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "flex h-10 w-10 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        isActive &&
          isPaneOpen &&
          "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
      title={label}
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}

export function IconBar() {
  return (
    <div className="flex h-full w-12 flex-col items-center border-r border-border bg-sidebar py-2">
      <div className="flex flex-1 flex-col gap-1">
        {navItems.map((item) => (
          <IconButton key={item.to} {...item} />
        ))}
      </div>
      <div className="flex flex-col gap-1">
        {bottomItems.map((item) => (
          <IconButton key={item.to} {...item} />
        ))}
      </div>
    </div>
  );
}
