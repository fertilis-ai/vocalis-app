import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Person } from "@/lib/schemas/people";

// The clickable speaker header in the transcript: shows the resolved name in the
// speaker's color and opens edits — rename, assign to a Person, or merge into
// another speaker (spec §2.2B, M3 item 5).

interface SpeakerMenuProps {
  label: string;
  name: string;
  color: string;
  assignedPersonId?: string;
  /** Named speaker override present (so we can offer "reset name"). */
  hasCustomName: boolean;
  otherSpeakers: { label: string; name: string }[];
  people: Person[];
  disabled?: boolean;
  onRename: () => void;
  onResetName: () => void;
  onAssign: (personId: string | null) => void;
  onMerge: (intoLabel: string) => void;
}

export function SpeakerMenu({
  name,
  color,
  assignedPersonId,
  hasCustomName,
  otherSpeakers,
  people,
  disabled,
  onRename,
  onResetName,
  onAssign,
  onMerge,
}: SpeakerMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className="group inline-flex items-center gap-1 rounded font-medium text-sm outline-none disabled:cursor-default"
        style={{ color }}
      >
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden
        />
        {name}
        {!disabled && (
          <ChevronDown className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60 group-data-[popup-open]:opacity-60" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuItem onClick={onRename}>Rename…</DropdownMenuItem>
        {hasCustomName && (
          <DropdownMenuItem onClick={onResetName}>Reset name</DropdownMenuItem>
        )}

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Assign to person</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-48">
            {people.length === 0 && (
              <DropdownMenuGroup>
                <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
                  No enrolled people
                </DropdownMenuLabel>
              </DropdownMenuGroup>
            )}
            {people.map((person) => (
              <DropdownMenuItem
                key={person.id}
                onClick={() => onAssign(person.id)}
              >
                <span
                  className="mr-2 h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: person.color }}
                  aria-hidden
                />
                {person.name}
                {assignedPersonId === person.id && (
                  <Check className="ml-auto h-3.5 w-3.5" />
                )}
              </DropdownMenuItem>
            ))}
            {assignedPersonId && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onAssign(null)}>
                  Unassign
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {otherSpeakers.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Merge into</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              {otherSpeakers.map((s) => (
                <DropdownMenuItem key={s.label} onClick={() => onMerge(s.label)}>
                  {s.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
