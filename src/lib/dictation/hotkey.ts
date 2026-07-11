import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "@/lib/storage";
import { useSettingsStore } from "@/stores/settings-store";

/** Keep the native global shortcut aligned with config.yaml-backed settings. */
export function initDictationHotkeySync(): () => void {
  if (!isDesktop()) return () => {};

  let configured = "";
  const configure = () => {
    const { hotkey, mode } = useSettingsStore.getState().dictation;
    const key = `${hotkey}\u0000${mode}`;
    if (key === configured) return;
    configured = key;
    invoke("dictation_configure_hotkey", { hotkey, mode }).catch((error) => {
      configured = "";
      console.warn("[dictation] Failed to configure global hotkey:", error);
    });
  };

  configure();
  return useSettingsStore.subscribe((state, previous) => {
    if (
      state.dictation.hotkey !== previous.dictation.hotkey ||
      state.dictation.mode !== previous.dictation.mode
    ) {
      configure();
    }
  });
}
