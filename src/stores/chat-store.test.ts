import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deletePath: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({ ...mocks, isDesktop: () => true }));

import { useChatStore } from "./chat-store";

function reset() {
  useChatStore.setState({ conversations: {}, corrupt: {} });
}

describe("chat-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.deletePath.mockResolvedValue(undefined);
    mocks.readFile.mockResolvedValue("");
  });

  it("createConversation writes a chat file and caches it", async () => {
    const conversation = await useChatStore.getState().createConversation({
      id: "11111111-1111-4111-8111-111111111111",
      title: "New chat",
    });

    expect(conversation.type).toBe("llm");
    expect(conversation.messages).toEqual([]);
    expect(conversation.ttsEnabled).toBe(false);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "~/.vocalis/chats/11111111-1111-4111-8111-111111111111.json",
      expect.stringContaining("New chat"),
    );
    expect(useChatStore.getState().conversations[conversation.id]).toEqual(conversation);
  });

  it("loadConversation returns null and does not throw on a corrupt file", async () => {
    mocks.readFile.mockResolvedValue("{ not json");
    const result = await useChatStore.getState().loadConversation("bad");
    expect(result).toBeNull();
    expect(useChatStore.getState().corrupt.bad).toBe(true);
    expect(mocks.writeFile).toHaveBeenCalledWith("~/.vocalis/chats/bad.json.bak", "{ not json");
  });

  it("loadConversation treats a missing/unreadable file as null, not corrupt", async () => {
    mocks.readFile.mockRejectedValue(new Error("no such file"));
    const result = await useChatStore.getState().loadConversation("missing");
    expect(result).toBeNull();
    expect(useChatStore.getState().corrupt.missing).toBeUndefined();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("updateConversation merges a patch, stamps updatedAt, and persists", async () => {
    const created = await useChatStore.getState().createConversation({
      id: "22222222-2222-4222-8222-222222222222",
      title: "Standup",
    });
    mocks.writeFile.mockClear();

    const next = await useChatStore.getState().updateConversation(created.id, {
      modelRef: "anthropic/claude-sonnet-4-5",
    });

    expect(next?.modelRef).toBe("anthropic/claude-sonnet-4-5");
    expect(next?.updatedAt).toBeDefined();
    expect(mocks.writeFile).toHaveBeenCalledWith(
      `~/.vocalis/chats/${created.id}.json`,
      expect.stringContaining("claude-sonnet-4-5"),
    );
  });

  it("appendMessage appends to the message list without dropping concurrent appends", async () => {
    const created = await useChatStore.getState().createConversation({
      id: "33333333-3333-4333-8333-333333333333",
      title: "Concurrent",
    });

    const messages = [
      { id: "a", role: "user" as const, content: "hi", createdAt: new Date().toISOString() },
      { id: "b", role: "assistant" as const, content: "hello", createdAt: new Date().toISOString() },
    ];
    await Promise.all(messages.map((m) => useChatStore.getState().appendMessage(created.id, m)));

    expect(useChatStore.getState().conversations[created.id]?.messages).toHaveLength(2);
  });

  it("updateMessage patches a single message by id", async () => {
    const created = await useChatStore.getState().createConversation({
      id: "44444444-4444-4444-8444-444444444444",
      title: "Edit",
    });
    await useChatStore.getState().appendMessage(created.id, {
      id: "msg-1",
      role: "assistant",
      content: "partial",
      createdAt: new Date().toISOString(),
    });

    const next = await useChatStore.getState().updateMessage(created.id, "msg-1", {
      content: "full response",
    });

    expect(next?.messages.find((m) => m.id === "msg-1")?.content).toBe("full response");
  });

  it("updateConversation refuses to write once quarantined as corrupt", async () => {
    mocks.readFile.mockResolvedValue("{ not json");
    await useChatStore.getState().loadConversation("bad");

    mocks.writeFile.mockClear();
    await expect(
      useChatStore.getState().updateConversation("bad", { title: "renamed" }),
    ).rejects.toThrow(/corrupt/i);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("removeConversation deletes the file and drops the cache", async () => {
    const created = await useChatStore.getState().createConversation({
      id: "55555555-5555-4555-8555-555555555555",
      title: "Bye",
    });

    await useChatStore.getState().removeConversation(created.id);

    expect(mocks.deletePath).toHaveBeenCalledWith(`~/.vocalis/chats/${created.id}.json`);
    expect(useChatStore.getState().conversations[created.id]).toBeUndefined();
  });
});
