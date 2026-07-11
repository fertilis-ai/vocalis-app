import {
  KeyRound,
  Keyboard,
  type LucideIcon,
  MessageSquare,
  Mic,
  Palette,
  HardDrive,
  Waypoints,
  Wrench,
} from "lucide-react";

// Settings sections (spec §2.7) — drives the sidebar and the anchor ids in
// the view. Section content lives in one component file per section.
export const SETTINGS_SECTIONS = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "api-keys", label: "API Keys", icon: KeyRound },
  { id: "routing", label: "Engines & Routing", icon: Waypoints },
  { id: "models", label: "Models & Storage", icon: HardDrive },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "dictation", label: "Dictation", icon: Keyboard },
  { id: "audio", label: "Audio", icon: Mic },
  { id: "advanced", label: "Advanced", icon: Wrench },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon }[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export function sectionAnchor(id: SettingsSectionId): string {
  return `section-${id}`;
}
