/**
 * Cross-window settings sync (main window → HUD window).
 *
 * Each webview window owns an independent Zustand settings store, and
 * config-sync + the keychain load run only in the main window. The main
 * window broadcasts the synced settings over a Tauri event whenever they
 * change (and mirrors privacy/polish into the tray check items); the HUD
 * window applies each broadcast so dictation always sees current polish,
 * privacy, and model-slot settings. API key values never cross the event
 * bus — the HUD reloads them from the keychain when the provider set
 * changes.
 */

import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import type { HueId } from "@/lib/hue-presets";
import { isDesktop } from "@/lib/storage";
import { type DictationPrefs, useSettingsStore } from "@/stores/settings-store";

const SYNC_EVENT = "settings-sync";
const SYNC_REQUEST_EVENT = "settings-sync-request";

interface SettingsSyncPayload {
  hue: HueId;
  privacyMode: boolean;
  dictation: DictationPrefs;
  activeByTask: Record<string, string>;
  /** HUD-started pipelines must honor the same capture device */
  audioInputDevice: string;
  /** Providers with a stored key (names only) — cue for a keychain reload. */
  apiProviders: string[];
}

function currentPayload(): SettingsSyncPayload {
  const s = useSettingsStore.getState();
  return {
    hue: s.hue,
    privacyMode: s.privacyMode,
    dictation: { ...s.dictation },
    activeByTask: { ...s.activeByTask },
    audioInputDevice: s.audioInputDevice,
    apiProviders: Object.keys(s.apiKeys)
      .filter((provider) => s.apiKeys[provider])
      .sort(),
  };
}

/**
 * Main window: push the synced settings to other windows and the tray on
 * every store change. Returns a dispose function.
 */
export function initSettingsBroadcast(): () => void {
  if (!isDesktop()) return () => {};
  let lastSent = "";
  const push = (force = false) => {
    const payload = currentPayload();
    const serialized = JSON.stringify(payload);
    if (!force && serialized === lastSent) return;
    lastSent = serialized;
    emit(SYNC_EVENT, payload).catch((err) => {
      console.warn("[settings-broadcast] Failed to emit settings:", err);
    });
    invoke("tray_set_toggles", {
      privacy: payload.privacyMode,
      polish: payload.dictation.polish,
    }).catch((err) => {
      console.warn("[settings-broadcast] Failed to update tray toggles:", err);
    });
  };

  let disposed = false;
  let unlistenRequest: (() => void) | undefined;
  // A window that spawns (or reloads) after our initial push can ask for a
  // fresh snapshot instead of waiting for the next settings change.
  void listen(SYNC_REQUEST_EVENT, () => push(true)).then((dispose) => {
    if (disposed) dispose();
    else unlistenRequest = dispose;
  });

  push();
  const unsubscribe = useSettingsStore.subscribe(() => push());
  return () => {
    disposed = true;
    unlistenRequest?.();
    unsubscribe();
  };
}

/**
 * HUD window: mirror broadcast settings into the local store and keep API
 * keys loadable for the polish pass. Returns a dispose function.
 */
export function initSettingsMirror(): () => void {
  if (!isDesktop()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  let knownProviders = "";

  // The keychain is the only source of API keys in this window: they are
  // excluded from localStorage persistence and config-sync never runs here.
  void useSettingsStore.getState().loadApiKeysFromKeychain();

  void listen<SettingsSyncPayload>(SYNC_EVENT, ({ payload }) => {
    const store = useSettingsStore.getState();
    store.setHue(payload.hue);
    store.setPrivacyMode(payload.privacyMode);
    store.setDictation(payload.dictation);
    store.setActiveByTask(payload.activeByTask);
    store.setAudioInputDevice(payload.audioInputDevice);
    const providers = payload.apiProviders.join(",");
    if (providers !== knownProviders) {
      knownProviders = providers;
      void store.loadApiKeysFromKeychain();
    }
  }).then((dispose) => {
    if (disposed) dispose();
    else unlisten = dispose;
    void emit(SYNC_REQUEST_EVENT);
  });

  return () => {
    disposed = true;
    unlisten?.();
  };
}
