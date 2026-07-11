import { Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { exportSession } from "@/lib/exports/export-session";
import type { ExportFormat, NameResolver } from "@/lib/exports/format";
import type { Session, Transcript } from "@/lib/schemas/session";

// Export dropdown for a session transcript (spec §2.2B, M3 item 5). Writes the
// chosen format under ~/.vocalis/exports/ and reveals it in Finder.

const FORMATS: { format: ExportFormat; label: string }[] = [
  { format: "markdown", label: "Markdown (.md)" },
  { format: "srt", label: "Subtitles (.srt)" },
  { format: "json", label: "JSON (.json)" },
];

interface ExportMenuProps {
  session: Session;
  transcript: Transcript;
  nameFor: NameResolver;
}

export function ExportMenu({ session, transcript, nameFor }: ExportMenuProps) {
  async function run(format: ExportFormat) {
    try {
      const path = await exportSession(format, session, transcript, nameFor);
      toast.success("Transcript exported", { description: path });
    } catch (err) {
      toast.error("Export failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" disabled={transcript.length === 0} />}
      >
        <Download className="mr-1.5 h-4 w-4" />
        Export
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Export transcript</DropdownMenuLabel>
        {FORMATS.map(({ format, label }) => (
          <DropdownMenuItem key={format} onClick={() => void run(format)}>
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
