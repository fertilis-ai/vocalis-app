import { createFileRoute } from "@tanstack/react-router";
import { AppLayout } from "@/components/layout/app-layout";
import { ModelsSidebar } from "@/components/models/models-sidebar";
import { ModelsView } from "@/components/models/models-view";

type ModelsSearch = {
  /** "all" or a catalog task id (e.g. "tts", "asr-streaming") */
  task: string;
};

export const Route = createFileRoute("/models")({
  validateSearch: (search: Record<string, unknown>): ModelsSearch => ({
    task: typeof search.task === "string" && search.task ? search.task : "all",
  }),
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <AppLayout section="models" leftPane={<ModelsSidebar />}>
      <ModelsView />
    </AppLayout>
  );
}
