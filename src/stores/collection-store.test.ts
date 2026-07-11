import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({ ...mocks, isDesktop: () => true }));

import { findNodeInTree } from "@/lib/tree-utils";
import { createCollectionStore } from "./collection-store";

const TREE_PATH = "chats/tree.json";

describe("collection-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.readFile.mockResolvedValue("");
  });

  it("load validates the tree and only hits disk once", async () => {
    const node = {
      id: "s1",
      name: "Session 1",
      type: "leaf",
      kind: "session",
      createdAt: "2026-07-01T00:00:00.000Z",
    };
    mocks.readFile.mockResolvedValue(JSON.stringify([node]));
    const store = createCollectionStore({ treePath: TREE_PATH });

    await store.getState().load();
    await store.getState().load();

    expect(store.getState().tree).toEqual([node]);
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
    expect(mocks.readFile).toHaveBeenCalledWith(TREE_PATH);
  });

  it("load skips a corrupt tree file without throwing, backs it up, and marks it corrupt", async () => {
    mocks.readFile.mockResolvedValue("{ not json");
    const store = createCollectionStore({ treePath: TREE_PATH });

    await store.getState().load();

    expect(store.getState().tree).toEqual([]);
    expect(store.getState().corrupt).toBe(true);
    expect(mocks.writeFile).toHaveBeenCalledWith(`${TREE_PATH}.bak`, "{ not json");
  });

  it("load treats a missing file as empty, not corrupt", async () => {
    mocks.readFile.mockRejectedValue(new Error("Failed to read file: No such file"));
    const store = createCollectionStore({ treePath: TREE_PATH });

    await store.getState().load();

    expect(store.getState().tree).toEqual([]);
    expect(store.getState().corrupt).toBe(false);
  });

  it("mutations are refused once the tree is marked corrupt", async () => {
    mocks.readFile.mockResolvedValue("{ not json");
    const store = createCollectionStore({ treePath: TREE_PATH });
    await store.getState().load();
    mocks.writeFile.mockClear();

    await expect(store.getState().createFolder("Work")).rejects.toThrow(/corrupt/i);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("createLeaf persists the tree and returns a node with the given kind", async () => {
    const store = createCollectionStore({ treePath: TREE_PATH });

    const leaf = await store.getState().createLeaf("session", "My meeting");

    expect(leaf.kind).toBe("session");
    expect(leaf.type).toBe("leaf");
    expect(store.getState().tree.map((n) => n.id)).toEqual([leaf.id]);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      TREE_PATH,
      expect.stringContaining(leaf.id),
    );
  });

  it("createFolder + createLeaf nests the leaf and auto-expands the folder", async () => {
    const store = createCollectionStore({ treePath: TREE_PATH });

    const folder = await store.getState().createFolder("Work");
    const leaf = await store.getState().createLeaf("session", "Standup", folder.id);

    expect(findNodeInTree(store.getState().tree, folder.id)?.children?.[0].id).toBe(
      leaf.id,
    );
    expect(store.getState().expandedFolders.has(folder.id)).toBe(true);
  });

  it("rename updates the node name", async () => {
    const store = createCollectionStore({ treePath: TREE_PATH });
    const leaf = await store.getState().createLeaf("session", "Old");

    await store.getState().rename(leaf.id, "New");

    expect(findNodeInTree(store.getState().tree, leaf.id)?.name).toBe("New");
  });

  it("togglePin flips the pinned flag", async () => {
    const store = createCollectionStore({ treePath: TREE_PATH });
    const leaf = await store.getState().createLeaf("session", "S");

    await store.getState().togglePin(leaf.id);
    expect(findNodeInTree(store.getState().tree, leaf.id)?.isPinned).toBe(true);
    await store.getState().togglePin(leaf.id);
    expect(findNodeInTree(store.getState().tree, leaf.id)?.isPinned).toBe(false);
  });

  it("remove of a folder deletes every contained leaf via onDeleteLeaf", async () => {
    const onDeleteLeaf = vi.fn().mockResolvedValue(undefined);
    const store = createCollectionStore({ treePath: TREE_PATH, onDeleteLeaf });
    const folder = await store.getState().createFolder("Work");
    const a = await store.getState().createLeaf("session", "A", folder.id);
    const b = await store.getState().createLeaf("chat", "B", folder.id);

    await store.getState().remove(folder.id);

    expect(store.getState().tree).toEqual([]);
    expect(onDeleteLeaf).toHaveBeenCalledWith(a.id, "session");
    expect(onDeleteLeaf).toHaveBeenCalledWith(b.id, "chat");
  });

  it("remove rejects and leaves the tree untouched when guardDeleteLeaf blocks it", async () => {
    const guardDeleteLeaf = vi.fn().mockReturnValue("nope");
    const onDeleteLeaf = vi.fn().mockResolvedValue(undefined);
    const store = createCollectionStore({ treePath: TREE_PATH, guardDeleteLeaf, onDeleteLeaf });
    const leaf = await store.getState().createLeaf("session", "S");
    mocks.writeFile.mockClear();

    await expect(store.getState().remove(leaf.id)).rejects.toThrow("nope");

    expect(store.getState().tree.map((n) => n.id)).toEqual([leaf.id]);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(onDeleteLeaf).not.toHaveBeenCalled();
  });

  it("remove rejects but still removes the node when onDeleteLeaf fails", async () => {
    const onDeleteLeaf = vi.fn().mockRejectedValue(new Error("disk full"));
    const store = createCollectionStore({ treePath: TREE_PATH, onDeleteLeaf });
    const leaf = await store.getState().createLeaf("session", "S");

    await expect(store.getState().remove(leaf.id)).rejects.toThrow(/failed to delete/i);

    expect(store.getState().tree).toEqual([]);
  });

  it("remove clears selection when the selected leaf disappears", async () => {
    const store = createCollectionStore({ treePath: TREE_PATH });
    const leaf = await store.getState().createLeaf("session", "S");
    store.getState().select(leaf.id);

    await store.getState().remove(leaf.id);

    expect(store.getState().selectedId).toBeNull();
  });

  it("move relocates a leaf into a folder", async () => {
    const store = createCollectionStore({ treePath: TREE_PATH });
    const folder = await store.getState().createFolder("Work");
    const leaf = await store.getState().createLeaf("session", "S");

    await store.getState().move(leaf.id, folder.id);

    expect(store.getState().tree.map((n) => n.id)).toEqual([folder.id]);
    expect(findNodeInTree(store.getState().tree, folder.id)?.children?.[0].id).toBe(
      leaf.id,
    );
  });
});
