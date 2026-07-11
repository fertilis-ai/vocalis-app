import { AsrFileSection } from "@/components/playground/asr-file-section";

export function AsrTool() {
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="font-semibold text-xl">Speech recognition</h1>
        <p className="text-muted-foreground text-sm">
          Batch file transcription, fully on-device.
        </p>
      </header>
      <AsrFileSection />
    </div>
  );
}
