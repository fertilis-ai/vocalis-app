import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deletePath: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({ ...mocks, isDesktop: () => true }));

import { useSessionStore } from "./session-store";

function reset() {
  useSessionStore.setState({ sessions: {}, transcripts: {}, corruptTranscripts: {} });
}

describe("session-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.deletePath.mockResolvedValue(undefined);
    mocks.readFile.mockResolvedValue("");
  });

  it("createSession writes a draft session.json + empty transcript and caches both", async () => {
    const session = await useSessionStore.getState().createSession({
      id: "11111111-1111-4111-8111-111111111111",
      title: "Kickoff",
      mode: "live",
    });

    expect(session.status).toBe("draft");
    expect(session.audioRetained).toBe(true);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "~/.vocalis/sessions/11111111-1111-4111-8111-111111111111/session.json",
      expect.stringContaining("Kickoff"),
    );
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "~/.vocalis/sessions/11111111-1111-4111-8111-111111111111/transcript.json",
      "[]",
    );
    expect(useSessionStore.getState().sessions[session.id]).toEqual(session);
    expect(useSessionStore.getState().transcripts[session.id]).toEqual([]);
  });

  it("loadSession returns null and does not throw on a corrupt file", async () => {
    mocks.readFile.mockResolvedValue("{ not json");
    const result = await useSessionStore.getState().loadSession("bad");
    expect(result).toBeNull();
  });

  it("updateSession merges a patch, stamps updatedAt, and persists", async () => {
    const created = await useSessionStore.getState().createSession({
      id: "22222222-2222-4222-8222-222222222222",
      title: "Standup",
      mode: "live",
    });
    mocks.writeFile.mockClear();

    const next = await useSessionStore.getState().updateSession(created.id, {
      status: "complete",
      durationMs: 5000,
    });

    expect(next?.status).toBe("complete");
    expect(next?.durationMs).toBe(5000);
    expect(next?.updatedAt).toBeDefined();
    expect(mocks.writeFile).toHaveBeenCalledWith(
      `~/.vocalis/sessions/${created.id}/session.json`,
      expect.stringContaining("complete"),
    );
  });

  it("loadTranscript treats a missing/unreadable file as empty, not corrupt", async () => {
    mocks.readFile.mockRejectedValue(new Error("no such file"));
    const result = await useSessionStore.getState().loadTranscript("missing");
    expect(result).toEqual([]);
    expect(useSessionStore.getState().corruptTranscripts.missing).toBeUndefined();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("loadTranscript backs up and quarantines a corrupt file, saveTranscript then refuses to write", async () => {
    mocks.readFile.mockResolvedValue("{ not json");
    const result = await useSessionStore.getState().loadTranscript("bad");

    expect(result).toEqual([]);
    expect(useSessionStore.getState().corruptTranscripts.bad).toBe(true);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "~/.vocalis/sessions/bad/transcript.json.bak",
      "{ not json",
    );

    mocks.writeFile.mockClear();
    await expect(
      useSessionStore.getState().saveTranscript("bad", []),
    ).rejects.toThrow(/corrupt/i);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("removeSession deletes the directory and drops the cache", async () => {
    const created = await useSessionStore.getState().createSession({
      id: "33333333-3333-4333-8333-333333333333",
      title: "Retro",
      mode: "import",
    });

    await useSessionStore.getState().removeSession(created.id);

    expect(mocks.deletePath).toHaveBeenCalledWith(
      `~/.vocalis/sessions/${created.id}`,
    );
    expect(useSessionStore.getState().sessions[created.id]).toBeUndefined();
  });
});
