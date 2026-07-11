import { v4 as uuid } from "uuid";
import { create } from "zustand";
import { type Enrollment, type Person, personSchema } from "@/lib/schemas/people";
import {
  deletePath,
  readDirectory,
  readFile,
  writeFile,
} from "@/lib/storage";

// Owns each Person's profile.json under ~/.vocalis/people/<id>/ (spec §4, §3.5).
// The averaged enrollment embedding (embedding.bin) and enrollment clips are
// written by the Rust enroll_person / enroll_record_start commands; this store
// owns only the metadata and keeps state mirrored to disk.

/** Palette for new-person colors — theme chart tokens, cycled by count. */
const PEOPLE_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function peopleDir(): string {
  return "~/.vocalis/people";
}
export function personDir(id: string): string {
  return `${peopleDir()}/${id}`;
}
function profilePath(id: string): string {
  return `${personDir(id)}/profile.json`;
}

/** Absolute-ish path to a person's embedding.bin for the session pipeline. */
export function embeddingPath(person: Person): string | null {
  if (!person.enrollment) return null;
  return `${personDir(person.id)}/${person.enrollment.embeddingPath}`;
}

interface PeopleState {
  /** person id → loaded profile */
  people: Record<string, Person>;
  loaded: boolean;
  /** Selected person in the Voices view (session-only, not persisted). */
  selectedId: string | null;

  loadAll: () => Promise<void>;
  select: (id: string | null) => void;
  create: (name: string, color?: string) => Promise<Person>;
  update: (id: string, patch: Partial<Person>) => Promise<Person | null>;
  remove: (id: string) => Promise<void>;
  /** Persist a freshly-built enrollment onto a person's profile. */
  saveEnrollment: (id: string, enrollment: Enrollment) => Promise<Person | null>;
}

export const usePeopleStore = create<PeopleState>()((set, get) => ({
  people: {},
  loaded: false,
  selectedId: null,

  loadAll: async () => {
    if (get().loaded) return;
    set({ loaded: true });
    const dirs = (await readDirectory(peopleDir(), 1)).filter(
      (n) => n.isDirectory,
    );
    const people: Record<string, Person> = {};
    for (const dir of dirs) {
      try {
        const raw = await readFile(`${personDir(dir.name)}/profile.json`);
        if (!raw) continue;
        const person = personSchema.parse(JSON.parse(raw));
        people[person.id] = person;
      } catch (err) {
        console.warn(`[people] unreadable profile for ${dir.name}:`, err);
      }
    }
    set({ people });
  },

  select: (id) => set({ selectedId: id }),

  create: async (name, color) => {
    const count = Object.keys(get().people).length;
    const person: Person = {
      id: uuid(),
      name,
      color: color ?? PEOPLE_PALETTE[count % PEOPLE_PALETTE.length],
      createdAt: new Date().toISOString(),
      enrollment: null,
      clones: {},
    };
    await writeFile(profilePath(person.id), JSON.stringify(person, null, 2));
    set((s) => ({
      people: { ...s.people, [person.id]: person },
      selectedId: person.id,
    }));
    return person;
  },

  update: async (id, patch) => {
    const current = get().people[id];
    if (!current) return null;
    const next: Person = { ...current, ...patch };
    await writeFile(profilePath(id), JSON.stringify(next, null, 2));
    set((s) => ({ people: { ...s.people, [id]: next } }));
    return next;
  },

  remove: async (id) => {
    await deletePath(personDir(id));
    set((s) => {
      const people = { ...s.people };
      delete people[id];
      return {
        people,
        selectedId: s.selectedId === id ? null : s.selectedId,
      };
    });
  },

  saveEnrollment: async (id, enrollment) => {
    return get().update(id, { enrollment });
  },
}));
