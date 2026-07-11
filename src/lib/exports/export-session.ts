import type { Session, Transcript } from "@/lib/schemas/session";
import { revealInFolder, writeFile } from "@/lib/storage";
import {
  EXPORT_EXTENSION,
  type ExportFormat,
  type NameResolver,
  formatTranscript,
} from "@/lib/exports/format";

// Writes a formatted transcript under ~/.vocalis/exports/ and reveals it in the
// OS file manager (spec §2.2B, §4). Formatting itself is pure (format.ts); this
// is the only fs-touching piece.

const EXPORTS_DIR = "~/.vocalis/exports";

/** Filesystem-safe slug from a session title. */
export function exportSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "session";
}

/** "20260710-143205" — sortable, filename-safe local timestamp. */
function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Format and write the transcript, returning the written path. Reveals it in
 * Finder unless `reveal` is false. No-op-safe in a browser (writeFile is).
 */
export async function exportSession(
  format: ExportFormat,
  session: Session,
  transcript: Transcript,
  nameFor: NameResolver,
  options: { reveal?: boolean } = {},
): Promise<string> {
  const content = formatTranscript(format, session, transcript, nameFor);
  const filename = `${exportSlug(session.title)}-${stamp(new Date())}.${EXPORT_EXTENSION[format]}`;
  const path = `${EXPORTS_DIR}/${filename}`;
  await writeFile(path, content);
  if (options.reveal !== false) await revealInFolder(path);
  return path;
}
