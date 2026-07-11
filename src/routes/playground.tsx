import { createFileRoute } from "@tanstack/react-router";
import { AppLayout } from "@/components/layout/app-layout";
import { PlaygroundSidebar } from "@/components/playground/playground-sidebar";
import { PlaygroundView } from "@/components/playground/playground-view";
import {
  DEFAULT_TOOL,
  isPlaygroundToolId,
  type PlaygroundToolId,
} from "@/components/playground/tools";

type PlaygroundSearch = {
  tool: PlaygroundToolId;
};

export const Route = createFileRoute("/playground")({
  validateSearch: (search: Record<string, unknown>): PlaygroundSearch => ({
    tool:
      typeof search.tool === "string" && isPlaygroundToolId(search.tool)
        ? search.tool
        : DEFAULT_TOOL,
  }),
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <AppLayout section="playground" leftPane={<PlaygroundSidebar />}>
      <PlaygroundView />
    </AppLayout>
  );
}
