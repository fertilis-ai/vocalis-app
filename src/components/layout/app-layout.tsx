import type * as React from "react";
import { IconBar } from "./sidebar";
import { ResizablePane } from "./resizable-pane";
import { useLayoutStore, type SectionId } from "@/stores/layout-store";

interface AppLayoutProps {
  section: SectionId;
  leftPane?: React.ReactNode;
  children: React.ReactNode;
}

export function AppLayout({ section, leftPane, children }: AppLayoutProps) {
  const { openSection, paneWidths, setPaneWidth } = useLayoutStore();
  const isPaneOpen = openSection === section;

  return (
    <div className="flex h-full">
      <IconBar />
      {leftPane && isPaneOpen && (
        <ResizablePane
          defaultWidth={paneWidths[section]}
          onWidthChange={(width) => setPaneWidth(section, width)}
        >
          {leftPane}
        </ResizablePane>
      )}
      <div className="flex-1 overflow-auto bg-sidebar">{children}</div>
    </div>
  );
}
