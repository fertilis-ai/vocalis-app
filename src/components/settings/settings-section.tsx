import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { type SettingsSectionId, sectionAnchor } from "./sections";

interface SettingsSectionProps {
  id: SettingsSectionId;
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  /** last section on the page skips the divider */
  last?: boolean;
}

export function SettingsSection({ id, title, icon: Icon, children, last }: SettingsSectionProps) {
  return (
    <section
      className={cn("scroll-mt-4", !last && "border-border border-b pb-8")}
      id={sectionAnchor(id)}
    >
      <h2 className="mb-4 flex items-center gap-2 font-medium text-lg">
        <Icon className="h-4.5 w-4.5 text-muted-foreground" />
        {title}
      </h2>
      {children}
    </section>
  );
}
