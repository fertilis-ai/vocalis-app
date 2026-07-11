import * as React from "react";
import { Pencil, Play } from "lucide-react";
import { Input } from "@/components/ui/input";
import { SpeakerMenu } from "@/components/sessions/speaker-menu";
import { msToClock } from "@/lib/exports/format";
import type { Person } from "@/lib/schemas/people";
import type { SpeakerRef, Transcript, TranscriptSegment } from "@/lib/schemas/session";
import { speakerDisplay } from "@/lib/sessions/transcript";
import { cn } from "@/lib/utils";

// Chat-style transcript: segments grouped into contiguous speaker turns, each
// turn headed by an editable, colored speaker name. Segments are click-to-play
// (when audio is retained), hand-editable, and styled subtly while provisional
// (spec §7.3). A live ASR partial renders as a trailing ghost line.

interface TranscriptListProps {
  transcript: Transcript;
  speakers: SpeakerRef[];
  people: Record<string, Person>;
  /** Live ASR partial shown as a ghost bubble while recording. */
  partial?: string;
  /** Play [startMs, endMs) — omitted when no retained audio is available. */
  onPlay?: (startMs: number, endMs: number) => void;
  /** False while recording: edits are disabled mid-capture. */
  editable: boolean;
  onRename: (label: string, name: string) => void;
  onResetName: (label: string) => void;
  onAssign: (label: string, personId: string | null) => void;
  onMerge: (fromLabel: string, toLabel: string) => void;
  onEditText: (segmentId: string, text: string) => void;
}

interface Group {
  label: string;
  segments: TranscriptSegment[];
}

function groupByspeaker(transcript: Transcript): Group[] {
  const groups: Group[] = [];
  for (const seg of transcript) {
    const last = groups.at(-1);
    if (last && last.label === seg.speakerLabel) last.segments.push(seg);
    else groups.push({ label: seg.speakerLabel, segments: [seg] });
  }
  return groups;
}

export function TranscriptList({
  transcript,
  speakers,
  people,
  partial,
  onPlay,
  editable,
  onRename,
  onResetName,
  onAssign,
  onMerge,
  onEditText,
}: TranscriptListProps) {
  const [renamingLabel, setRenamingLabel] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editValue, setEditValue] = React.useState("");

  const groups = React.useMemo(() => groupByspeaker(transcript), [transcript]);

  function beginRename(label: string, current: string) {
    setRenamingLabel(label);
    setRenameValue(current);
  }
  function commitRename() {
    if (renamingLabel) onRename(renamingLabel, renameValue);
    setRenamingLabel(null);
  }
  function beginEdit(seg: TranscriptSegment) {
    if (!editable) return;
    setEditingId(seg.id);
    setEditValue(seg.text);
  }
  function commitEdit() {
    if (editingId) onEditText(editingId, editValue.trim());
    setEditingId(null);
  }

  if (transcript.length === 0 && !partial) {
    return (
      <p className="px-4 py-8 text-center text-muted-foreground text-sm">
        No transcript yet.
      </p>
    );
  }

  return (
    <div className="space-y-5 px-4 py-4">
      {groups.map((group) => {
        const display = speakerDisplay(group.label, speakers, people);
        const ref = speakers.find((s) => s.label === group.label);
        const others = speakers
          .filter((s) => s.label !== group.label)
          .map((s) => ({
            label: s.label,
            name: speakerDisplay(s.label, speakers, people).name,
          }));

        return (
          <div key={group.segments[0].id} className="space-y-1">
            <div className="flex items-center gap-2">
              {renamingLabel === group.label ? (
                <Input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    else if (e.key === "Escape") setRenamingLabel(null);
                  }}
                  className="h-7 w-40 text-sm"
                />
              ) : (
                <SpeakerMenu
                  label={group.label}
                  name={display.name}
                  color={display.color}
                  assignedPersonId={ref?.personId}
                  hasCustomName={!!ref?.name}
                  otherSpeakers={others}
                  people={Object.values(people)}
                  disabled={!editable}
                  onRename={() => beginRename(group.label, display.name)}
                  onResetName={() => onResetName(group.label)}
                  onAssign={(personId) => onAssign(group.label, personId)}
                  onMerge={(into) => onMerge(group.label, into)}
                />
              )}
            </div>

            <div
              className="space-y-1 border-l-2 pl-3"
              style={{ borderColor: display.color }}
            >
              {group.segments.map((seg) => (
                <div key={seg.id} className="group flex items-start gap-2">
                  {onPlay && (
                    <button
                      type="button"
                      onClick={() => onPlay(seg.startMs, seg.endMs)}
                      className="mt-0.5 flex h-5 items-center gap-1 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                      title={`Play from ${msToClock(seg.startMs)}`}
                    >
                      <Play className="h-3 w-3" />
                    </button>
                  )}
                  <span className="mt-0.5 w-10 shrink-0 select-none font-mono text-[10px] text-muted-foreground">
                    {msToClock(seg.startMs)}
                  </span>
                  {editingId === seg.id ? (
                    <textarea
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          commitEdit();
                        } else if (e.key === "Escape") setEditingId(null);
                      }}
                      className="flex-1 resize-none rounded border border-border bg-background p-1 text-sm outline-none focus:ring-1 focus:ring-ring"
                      rows={Math.max(1, Math.ceil(editValue.length / 60))}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => beginEdit(seg)}
                      className={cn(
                        "flex-1 cursor-text text-left text-sm leading-relaxed",
                        seg.provisional && "text-muted-foreground italic",
                        !editable && "cursor-default",
                      )}
                      title={editable ? "Click to edit" : undefined}
                    >
                      {seg.text || (
                        <span className="text-muted-foreground">…</span>
                      )}
                      {seg.edited && (
                        <Pencil className="ml-1 inline h-2.5 w-2.5 text-muted-foreground/60" />
                      )}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {partial && (
        <div className="space-y-1">
          <span className="text-muted-foreground text-sm italic">Speaking…</span>
          <p className="border-muted-foreground/30 border-l-2 pl-3 text-muted-foreground text-sm italic">
            {partial}
          </p>
        </div>
      )}
    </div>
  );
}
