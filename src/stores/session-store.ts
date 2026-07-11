import { create } from "zustand";
import {
  type Session,
  type SessionMode,
  type Transcript,
  sessionSchema,
  transcriptSchema,
} from "@/lib/schemas/session";
import { deletePath, readFile, writeFile } from "@/lib/storage";
import { serialize } from "@/lib/write-queue";

// Owns the per-session files under ~/.vocalis/sessions/<id>/ (spec §4):
//   session.json    — metadata (sessionSchema)
//   transcript.json — ordered segments (transcriptSchema)
// The sidebar tree (which sessions exist, in what folders) is owned by the
// collection store; this store owns each session's content. State mirrors disk.

export function sessionDir(id: string): string {
  return `~/.vocalis/sessions/${id}`;
}
function sessionPath(id: string): string {
  return `${sessionDir(id)}/session.json`;
}
function transcriptPath(id: string): string {
  return `${sessionDir(id)}/transcript.json`;
}
/** Retained capture / normalized import audio (16 kHz mono wav; spec §4). */
export function sessionAudioPath(id: string): string {
  return `${sessionDir(id)}/audio.wav`;
}

export interface NewSession {
  id: string;
  title: string;
  mode: SessionMode;
  engineId?: string | null;
  audioRetained?: boolean;
}

interface SessionState {
  /** session id → loaded metadata */
  sessions: Record<string, Session>;
  /** session id → loaded transcript */
  transcripts: Record<string, Transcript>;
  /**
   * Session ids whose transcript.json existed but failed to parse/validate. A
   * backup was written to `transcript.json.bak`; `saveTranscript` refuses to
   * write for that id until the app is restarted (after the file is fixed or
   * removed) so nothing overwrites the quarantined original.
   */
  corruptTranscripts: Record<string, boolean>;

  loadSession: (id: string) => Promise<Session | null>;
  loadTranscript: (id: string) => Promise<Transcript>;
  /** Create a draft session.json (and empty transcript.json) on disk. */
  createSession: (init: NewSession) => Promise<Session>;
  updateSession: (id: string, patch: Partial<Session>) => Promise<Session | null>;
  saveTranscript: (id: string, transcript: Transcript) => Promise<void>;
  /** Delete the whole session directory. */
  removeSession: (id: string) => Promise<void>;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: {},
  transcripts: {},
  corruptTranscripts: {},

  loadSession: async (id) => {
    const cached = get().sessions[id];
    if (cached) return cached;
    try {
      const raw = await readFile(sessionPath(id));
      if (!raw) return null;
      const session = sessionSchema.parse(JSON.parse(raw));
      set((s) => ({ sessions: { ...s.sessions, [id]: session } }));
      return session;
    } catch (err) {
      console.warn(`[session] unreadable session ${id}:`, err);
      return null;
    }
  },

  loadTranscript: async (id) => {
    const cached = get().transcripts[id];
    if (cached) return cached;
    let raw: string;
    try {
      raw = await readFile(transcriptPath(id));
    } catch {
      // No file yet or otherwise unreadable — treat as empty, not corrupt;
      // the next save will create it.
      return [];
    }
    if (!raw) return [];
    try {
      const transcript = transcriptSchema.parse(JSON.parse(raw));
      set((s) => ({ transcripts: { ...s.transcripts, [id]: transcript } }));
      return transcript;
    } catch (err) {
      console.error(`[session] corrupt transcript ${id}, quarantining:`, err);
      await writeFile(`${transcriptPath(id)}.bak`, raw).catch(() => {});
      set((s) => ({ corruptTranscripts: { ...s.corruptTranscripts, [id]: true } }));
      return [];
    }
  },

  createSession: async (init) => {
    const session: Session = {
      id: init.id,
      title: init.title,
      createdAt: new Date().toISOString(),
      mode: init.mode,
      audioRetained: init.audioRetained ?? true,
      engineId: init.engineId ?? null,
      speakers: [],
      status: "draft",
    };
    await writeFile(sessionPath(session.id), JSON.stringify(session, null, 2));
    await writeFile(transcriptPath(session.id), JSON.stringify([], null, 2));
    set((s) => ({
      sessions: { ...s.sessions, [session.id]: session },
      transcripts: { ...s.transcripts, [session.id]: [] },
    }));
    return session;
  },

  updateSession: async (id, patch) => {
    // Serialized per session id: two concurrent updates would otherwise both
    // read the same `current`, and whichever writes last clobbers the other's
    // patch (spec M8).
    return serialize(`session:${id}`, async () => {
      const current = get().sessions[id] ?? (await get().loadSession(id));
      if (!current) return null;
      const next: Session = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      await writeFile(sessionPath(id), JSON.stringify(next, null, 2));
      set((s) => ({ sessions: { ...s.sessions, [id]: next } }));
      return next;
    });
  },

  saveTranscript: async (id, transcript) => {
    // Serialized per session id so an in-flight refined-transcript write can't
    // be overtaken by a stale provisional one (spec M8).
    return serialize(`transcript:${id}`, async () => {
      if (get().corruptTranscripts[id]) {
        throw new Error(
          `${transcriptPath(id)} was corrupt and has been backed up to ${transcriptPath(id)}.bak. ` +
            "Fix or remove it and restart the app before saving this transcript again.",
        );
      }
      await writeFile(transcriptPath(id), JSON.stringify(transcript, null, 2));
      set((s) => ({ transcripts: { ...s.transcripts, [id]: transcript } }));
    });
  },

  removeSession: async (id) => {
    await deletePath(sessionDir(id));
    set((s) => {
      const sessions = { ...s.sessions };
      const transcripts = { ...s.transcripts };
      const corruptTranscripts = { ...s.corruptTranscripts };
      delete sessions[id];
      delete transcripts[id];
      delete corruptTranscripts[id];
      return { sessions, transcripts, corruptTranscripts };
    });
  },
}));
