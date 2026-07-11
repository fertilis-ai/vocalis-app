import { createFileRoute } from "@tanstack/react-router";
import { AppLayout } from "@/components/layout/app-layout";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { SettingsView } from "@/components/settings/settings-view";

export const Route = createFileRoute("/settings")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <AppLayout section="settings" leftPane={<SettingsSidebar />}>
      <SettingsView />
    </AppLayout>
  );
}
