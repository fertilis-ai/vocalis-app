/**
 * App logger
 *
 * Writes timestamped entries to daily files in ~/.vocalis/logs/
 * (vocalis-YYYY-MM-DD.log) when running on desktop; falls back to the
 * console in a plain browser. The debug pane (spec §2.8) reads these
 * files back through the same commands.
 *
 * Format: [ISO timestamp] [COMPONENT] message
 */

import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "@/lib/storage";

export type LogComponent =
  | "APP" // startup / lifecycle
  | "CONFIG" // config.yaml sync
  | "AUDIO" // capture / playback
  | "PIPELINE" // realtime pipeline events
  | "ENGINE" // engine load/unload, inference
  | "MODEL" // catalog / downloads
  | "UI"; // webview-side events

// Updated by the settings store when the debug-logging toggle changes.
let loggingEnabled = false;

export function setLoggingEnabled(enabled: boolean): void {
  loggingEnabled = enabled;
}

export function isLoggingEnabled(): boolean {
  return loggingEnabled;
}

/** Daily log file name, e.g. "vocalis-2026-07-09.log" */
export function currentLogFileName(now: Date = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `vocalis-${yyyy}-${mm}-${dd}.log`;
}

function formatLogEntry(component: LogComponent, message: string, data?: unknown): string {
  const timestamp = new Date().toISOString();
  let entry = `[${timestamp}] [${component}] ${message}`;

  if (data !== undefined) {
    try {
      const dataStr = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      const truncated =
        dataStr.length > 1000 ? `${dataStr.slice(0, 1000)}... (truncated)` : dataStr;
      entry += `\n  Data: ${truncated}`;
    } catch {
      entry += "\n  Data: [unable to serialize]";
    }
  }

  return entry;
}

/**
 * Log an app event. Fire-and-forget on desktop (never blocks the caller);
 * console in the browser.
 */
export function logApp(component: LogComponent, message: string, data?: unknown): void {
  if (!loggingEnabled) return;

  const entry = formatLogEntry(component, message, data);

  if (!isDesktop()) {
    console.log(entry);
    return;
  }

  invoke("append_log_file", { filename: currentLogFileName(), line: entry }).catch((error) => {
    console.warn("[logger] Failed to write log:", error);
  });
}

/** List log files in ~/.vocalis/logs/ (newest last — names sort by date) */
export async function listLogFiles(): Promise<string[]> {
  if (!isDesktop()) return [];
  try {
    return await invoke<string[]>("list_log_files");
  } catch (error) {
    console.warn("[logger] Failed to list log files:", error);
    return [];
  }
}

/** Read a log file's contents (empty string if missing) */
export async function readLogFile(filename: string): Promise<string> {
  if (!isDesktop()) return "";
  try {
    return await invoke<string>("read_log_file", { filename });
  } catch (error) {
    console.warn("[logger] Failed to read log file:", error);
    return "";
  }
}

/** Clear a log file */
export async function clearLogFile(filename: string): Promise<void> {
  if (!isDesktop()) return;
  try {
    await invoke("clear_log_file", { filename });
  } catch (error) {
    console.warn("[logger] Failed to clear log file:", error);
  }
}
