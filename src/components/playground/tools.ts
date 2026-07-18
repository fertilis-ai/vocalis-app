import {
  Activity,
  AudioLines,
  Fingerprint,
  Globe,
  Mic,
  MicVocal,
  Radio,
  ScanSearch,
  SplitSquareHorizontal,
  Type,
  UserCheck,
  Users,
} from "lucide-react";

// The ten sherpa-onnx capabilities plus the Streaming Recognition demo page
// and the Voice cloning bench (spec/spec.md §2.3) — spec §0 moved
// chat/sessions/dictation to batch ASR, so streaming decode now only lives
// here. Pages come online per milestone; `available: false` renders the
// ComingSoon panel.
export const PLAYGROUND_TOOLS = [
  {
    id: "asr",
    label: "Speech recognition",
    icon: Mic,
    available: true,
  },
  {
    id: "asr-streaming",
    label: "Streaming Recognition",
    icon: Radio,
    available: true,
  },
  {
    id: "tts",
    label: "Speech synthesis",
    icon: AudioLines,
    available: true,
  },
  {
    id: "clone",
    label: "Voice cloning",
    icon: MicVocal,
    available: true,
  },
  {
    id: "vad",
    label: "Voice activity detection",
    icon: Activity,
    available: true,
  },
  {
    id: "speaker-id",
    label: "Speaker identification",
    icon: Users,
    available: true,
  },
  {
    id: "speaker-verify",
    label: "Speaker verification",
    icon: UserCheck,
    available: true,
  },
  {
    id: "diarization",
    label: "Speaker diarization",
    icon: Fingerprint,
    available: true,
  },
  {
    id: "punctuation",
    label: "Punctuation",
    icon: Type,
    available: true,
  },
  {
    id: "kws",
    label: "Keyword spotting",
    icon: ScanSearch,
    available: true,
  },
  {
    id: "separation",
    label: "Source separation",
    icon: SplitSquareHorizontal,
    available: true,
  },
  {
    id: "lang-id",
    label: "Spoken language ID",
    icon: Globe,
    available: true,
  },
] as const;

export type PlaygroundToolId = (typeof PLAYGROUND_TOOLS)[number]["id"];

export const DEFAULT_TOOL: PlaygroundToolId = "asr";

export function isPlaygroundToolId(value: string): value is PlaygroundToolId {
  return PLAYGROUND_TOOLS.some((t) => t.id === value);
}
