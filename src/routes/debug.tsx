import { createFileRoute } from "@tanstack/react-router";
import { AppLayout } from "@/components/layout/app-layout";
import {
  PlaceholderSidebar,
  PlaceholderView,
} from "@/components/shared/placeholder-view";

export const Route = createFileRoute("/debug")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <AppLayout section="debug" leftPane={<PlaceholderSidebar title="Debug" />}>
      <PlaceholderView title="Debug" description="Logs and the live pipeline inspector" />
    </AppLayout>
  );
}
