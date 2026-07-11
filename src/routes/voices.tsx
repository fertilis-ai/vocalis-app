import { createFileRoute } from "@tanstack/react-router";
import { AppLayout } from "@/components/layout/app-layout";
import { VoicesContent } from "@/components/voices/voices-content";
import { VoicesSidebar } from "@/components/voices/voices-sidebar";

export const Route = createFileRoute("/voices")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <AppLayout section="voices" leftPane={<VoicesSidebar />}>
      <VoicesContent />
    </AppLayout>
  );
}
