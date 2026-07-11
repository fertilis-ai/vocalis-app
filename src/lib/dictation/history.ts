import { v4 as uuid } from "uuid";
import {
  dictationHistorySchema,
  type DictationHistoryEntry,
} from "@/lib/schemas/dictation-history";
import { getAppDataDir, isDesktop, pathExists, readFile, writeFile } from "@/lib/storage";

async function historyPath(): Promise<string | null> {
  const appDataDir = await getAppDataDir();
  return appDataDir ? `${appDataDir}/dictation-history.json` : null;
}

export async function loadDictationHistory(): Promise<DictationHistoryEntry[]> {
  if (!isDesktop()) return [];
  const path = await historyPath();
  if (!path || !(await pathExists(path))) return [];
  try {
    return dictationHistorySchema.parse(JSON.parse(await readFile(path)));
  } catch (error) {
    console.warn("[dictation] Ignoring invalid history:", error);
    return [];
  }
}

/** Store text only after it was successfully copied or injected; never audio. */
export async function recordDictation(text: string): Promise<void> {
  if (!text.trim() || !isDesktop()) return;
  const path = await historyPath();
  if (!path) return;
  const history = await loadDictationHistory();
  const entry: DictationHistoryEntry = {
    id: uuid(),
    text: text.trim(),
    createdAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify([entry, ...history].slice(0, 50), null, 2));
}
