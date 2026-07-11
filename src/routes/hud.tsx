import { createFileRoute } from "@tanstack/react-router";
import { DictationHud } from "@/components/dictation/dictation-hud";

export const Route = createFileRoute("/hud")({
  component: DictationHud,
});
