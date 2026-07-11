/**
 * Config Sync
 *
 * Two-way sync between the Zustand settings store and ~/.vocalis/config.yaml:
 * store changes are written debounced (500 ms), external file edits are
 * picked up by a 2 s poll. In browser mode this module is a no-op.
 *
 * Synced fields: hue, privacyMode, routing, dictation, models.activeByTask,
 * audio, cache.ttsMaxBytes, localLlm, voiceChat. Fields the store doesn't own
 * (appearance.theme — next-themes owns it via localStorage) are preserved
 * from the last-loaded file content so writes never clobber hand edits to
 * them.
 */

import YAML from "yaml";
import { getAppDataDir, isDesktop, pathExists, readFile, writeFile } from "@/lib/storage";
import { type ConfigYaml, defaultConfig, parseConfig } from "@/lib/schemas/config";
import { useSettingsStore } from "@/stores/settings-store";

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;
let lastKnownContent: string | null = null;
let lastLoadedConfig: ConfigYaml = defaultConfig();
let isPatchingFromFile = false;
let writeInFlight = false;

/** Merge the store's synced fields over the last-loaded config */
function extractConfigFromStore(): ConfigYaml {
  const s = useSettingsStore.getState();
  return {
    ...lastLoadedConfig,
    appearance: { ...lastLoadedConfig.appearance, hue: s.hue },
    privacyMode: s.privacyMode,
    routing: { ...lastLoadedConfig.routing, ...s.routing },
    dictation: { ...s.dictation },
    models: { ...lastLoadedConfig.models, activeByTask: { ...s.activeByTask } },
    audio: { ...lastLoadedConfig.audio, inputDevice: s.audioInputDevice },
    cache: { ...lastLoadedConfig.cache, ttsMaxBytes: s.ttsCacheMaxBytes },
    localLlm: { ...s.localLLM },
    voiceChat: { ...s.voiceChat },
  };
}

async function getConfigPath(): Promise<string> {
  const dir = await getAppDataDir();
  return `${dir}/config.yaml`;
}

async function writeConfigToFile(): Promise<void> {
  const config = extractConfigFromStore();
  const yaml = YAML.stringify(config);
  const configPath = await getConfigPath();
  await writeFile(configPath, yaml);
  lastKnownContent = yaml;
  lastLoadedConfig = config;
}

function debouncedWriteConfig(): void {
  if (isPatchingFromFile) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    writeInFlight = true;
    writeConfigToFile()
      .catch((err) => {
        console.warn("[config-sync] Failed to write config.yaml:", err);
      })
      .finally(() => {
        writeInFlight = false;
      });
  }, 500);
}

async function loadConfigFromFile(providedContent?: string): Promise<void> {
  const configPath = await getConfigPath();

  if (!(await pathExists(configPath))) {
    // No config file yet — write current store state as initial config
    await writeConfigToFile();
    return;
  }

  try {
    const content = providedContent ?? (await readFile(configPath));
    let parsed: unknown;
    try {
      parsed = YAML.parse(content);
    } catch (err) {
      console.warn("[config-sync] config.yaml is not valid YAML, ignoring:", err);
      return;
    }
    if (!parsed || typeof parsed !== "object") return;

    const config = parseConfig(parsed);

    isPatchingFromFile = true;
    try {
      const store = useSettingsStore.getState();
      store.setHue(config.appearance.hue);
      store.setPrivacyMode(config.privacyMode);
      store.setRouting(config.routing);
      store.setDictation(config.dictation);
      store.setActiveByTask(config.models.activeByTask);
      store.setAudioInputDevice(config.audio.inputDevice);
      store.setTtsCacheMaxBytes(config.cache.ttsMaxBytes);
      store.setLocalLLM(config.localLlm);
      store.setVoiceChat(config.voiceChat);

      lastKnownContent = content;
      lastLoadedConfig = config;
    } finally {
      isPatchingFromFile = false;
    }
  } catch (err) {
    console.warn("[config-sync] Failed to load config.yaml, using defaults:", err);
  }
}

async function pollForFileChanges(): Promise<void> {
  if (debounceTimer || writeInFlight) return;
  try {
    const configPath = await getConfigPath();
    if (!(await pathExists(configPath))) return;
    const content = await readFile(configPath);
    if (content !== lastKnownContent) {
      await loadConfigFromFile(content);
    }
  } catch {
    // File might be mid-write by an external editor; next poll catches it
  }
}

/** Flush any pending debounced write immediately (best-effort before unload) */
function flushPendingWrite(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    writeInFlight = true;
    writeConfigToFile()
      .catch(() => {})
      .finally(() => {
        writeInFlight = false;
      });
  }
}

/**
 * Initialize config sync.
 * - In browser mode: no-op.
 * - On desktop: loads config.yaml + keychain keys into the store, then
 *   subscribes to store changes.
 */
export async function initConfigSync(): Promise<void> {
  if (!isDesktop()) return;

  await loadConfigFromFile();
  await useSettingsStore.getState().loadApiKeysFromKeychain();

  // Subscribe to store changes — write config.yaml on every change (debounced)
  unsubscribe = useSettingsStore.subscribe(debouncedWriteConfig);

  // Flush pending writes before the window closes
  window.addEventListener("beforeunload", flushPendingWrite);

  // Poll for external changes to config.yaml every 2s
  pollTimer = setInterval(() => {
    pollForFileChanges();
  }, 2000);
}

/** Tear down the subscription and polling (useful for testing) */
export function stopConfigSync(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  window.removeEventListener("beforeunload", flushPendingWrite);
  lastKnownContent = null;
  lastLoadedConfig = defaultConfig();
  isPatchingFromFile = false;
  writeInFlight = false;
}
