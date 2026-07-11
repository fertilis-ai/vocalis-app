import { PlaceholderView } from "@/components/shared/placeholder-view";
import { usePeopleStore } from "@/stores/people-store";
import { PersonDetail } from "./person-detail";

// Resolves the selected person to their detail view; the TTS voice library
// (the Voices section's other half) arrives with M5 voice cloning.

export function VoicesContent() {
  const selectedId = usePeopleStore((s) => s.selectedId);
  const person = usePeopleStore((s) => (selectedId ? s.people[selectedId] : null));

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
