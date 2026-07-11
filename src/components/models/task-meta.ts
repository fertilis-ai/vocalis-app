import {
  Activity,
  AudioLines,
  FileAudio,
  Fingerprint,
  Globe,
  type LucideIcon,
  Mic,
  ScanSearch,
  Speech,
  SplitSquareHorizontal,
  Type,
  Users,
} from "lucide-react";

// Display metadata for the model tasks (spec §5 / registry/mod.rs task ids).
// Tasks the catalog may grow into are listed too so the sidebar stays ordered.
export const TASK_META: Record<string, { label: string; icon: LucideIcon }> = {
  vad: { label: "Voice activity detection", icon: Activity },
  "asr-streaming": { label: "Streaming recognition", icon: Mic },
  "asr-batch": { label: "Batch recognition", icon: FileAudio },
  tts: { label: "Speech synthesis", icon: AudioLines },
  "clone-tts": { label: "Voice cloning", icon: Speech },
  "speaker-embedding": { label: "Speaker embedding", icon: Users },
  diarization: { label: "Speaker diarization", icon: Fingerprint },
  punctuation: { label: "Punctuation", icon: Type },
  kws: { label: "Keyword spotting", icon: ScanSearch },
  separation: { label: "Source separation", icon: SplitSquareHorizontal },
  "lang-id": { label: "Spoken language ID", icon: Globe },
};

const TASK_ORDER = Object.keys(TASK_META);

export function taskLabel(task: string): string {
  return TASK_META[task]?.label ?? task;
}

/** Tasks present in the catalog, in canonical order (unknown tasks last). */
export function orderTasks(tasks: Iterable<string>): string[] {
  return [...new Set(tasks)].sort((a, b) => {
    const ia = TASK_ORDER.indexOf(a);
    const ib = TASK_ORDER.indexOf(b);
    return (ia === -1 ? TASK_ORDER.length : ia) - (ib === -1 ? TASK_ORDER.length : ib);
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
