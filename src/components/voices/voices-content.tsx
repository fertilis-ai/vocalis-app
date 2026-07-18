import { PlaceholderView } from "@/components/shared/placeholder-view";
import { usePeopleStore } from "@/stores/people-store";
import { useVoicesStore } from "@/stores/voices-store";
import { PersonDetail } from "./person-detail";
import { VoiceLibrary } from "./voice-library";

// The Voices section's main pane (spec §2.4, two tabs): the People tab
// resolves the selected person to their detail view; the Voice library tab
// lists everything speakable (M5 item 4).

export function VoicesContent() {
  const view = useVoicesStore((s) => s.view);
  const selectedId = usePeopleStore((s) => s.selectedId);
  const person = usePeopleStore((s) => (selectedId ? s.people[selectedId] : null));

  if (view === "library") {
    return <VoiceLibrary />;
  }

  if (!person) {
    return (
      <PlaceholderView
        title="People"
        description="Enroll people so transcription sessions can label them by name. Select a person or add one with +."
      />
    );
  }

  return <PersonDetail key={person.id} person={person} />;
}
