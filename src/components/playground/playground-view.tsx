import { useSearch } from "@tanstack/react-router";
import { AsrTool } from "./asr-tool";
import { CloneTool } from "./clone-tool";
import { DiarizationTool } from "./diarization-tool";
import { KwsTool } from "./kws-tool";
import { LangIdTool } from "./langid-tool";
import { PunctuationTool } from "./punctuation-tool";
import { SeparationTool } from "./separation-tool";
import { SpeakerIdTool } from "./speaker-id-tool";
import { SpeakerVerifyTool } from "./speaker-verify-tool";
import { StreamingRecognitionTool } from "./streaming-recognition-tool";
import { PLAYGROUND_TOOLS } from "./tools";
import { TtsTool } from "./tts-tool";
import { VadTool } from "./vad-tool";

export function PlaygroundView() {
  const { tool } = useSearch({ from: "/playground" });

  switch (tool) {
    case "asr":
      return <AsrTool />;
    case "asr-streaming":
      return <StreamingRecognitionTool />;
    case "tts":
      return <TtsTool />;
    case "clone":
      return <CloneTool />;
    case "vad":
      return <VadTool />;
    case "speaker-id":
      return <SpeakerIdTool />;
    case "speaker-verify":
      return <SpeakerVerifyTool />;
    case "diarization":
      return <DiarizationTool />;
    case "punctuation":
      return <PunctuationTool />;
    case "kws":
      return <KwsTool />;
    case "separation":
      return <SeparationTool />;
    case "lang-id":
      return <LangIdTool />;
    default:
      return <ComingSoon toolId={tool} />;
  }
}

function ComingSoon({ toolId }: { toolId: string }) {
  const tool = PLAYGROUND_TOOLS.find((t) => t.id === toolId);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <h1 className="font-semibold text-xl">{tool?.label ?? "Unknown tool"}</h1>
      <p className="max-w-md text-muted-foreground text-sm">
        This capability lands in an upcoming milestone (spec/spec.md §8). The engine
        already exists in sherpa-onnx — only the bench page is pending.
      </p>
    </div>
  );
}
