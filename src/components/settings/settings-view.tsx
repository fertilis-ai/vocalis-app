import { AdvancedSettings } from "./advanced-settings";
import { ApiKeysSettings } from "./api-keys-settings";
import { AppearanceSettings } from "./appearance-settings";
import { AudioSettings } from "./audio-settings";
import { ChatSettings } from "./chat-settings";
import { DictationSettings } from "./dictation-settings";
import { ModelsSettings } from "./models-settings";
import { RoutingSettings } from "./routing-settings";

// Section order mirrors SETTINGS_SECTIONS (sections.ts) so sidebar jumps
// land where the reader expects.
export function SettingsView() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 items-center border-border border-b px-2">
        <span className="font-medium text-sm">Settings</span>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-2xl space-y-8">
          <AppearanceSettings />
          <ApiKeysSettings />
          <RoutingSettings />
          <ModelsSettings />
          <ChatSettings />
          <DictationSettings />
          <AudioSettings />
          <AdvancedSettings />
        </div>
      </div>
    </div>
  );
}
