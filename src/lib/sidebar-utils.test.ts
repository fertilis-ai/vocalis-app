import { describe, it, expect } from "vitest";
import { splitByPinned, collectTreeIds, collectFolders } from "./sidebar-utils";

describe("splitByPinned", () => {
  it("separates pinned folders from unpinned items", () => {
    const tree = [
      { type: "folder", id: "f1", isPinned: true },
      { type: "folder", id: "f2", isPinned: false },
      { type: "conversation", id: "c1" },
    ];
    const { pinned, unpinned } = splitByPinned(tree);
    expect(pinned).toEqual([{ type: "folder", id: "f1", isPinned: true }]);
    expect(unpinned).toEqual([
      { type: "folder", id: "f2", isPinned: false },
      { type: "conversation", id: "c1" },
    ]);
  });

  it("returns empty pinned when no folders are pinned", () => {
    const tree = [
      { type: "folder", id: "f1" },
      { type: "conversation", id: "c1" },
    ];
    const { pinned, unpinned } = splitByPinned(tree);
    expect(pinned).toEqual([]);
    expect(unpinned).toEqual(tree);
  });

  it("only considers folders for pinning (pinned conversations stay unpinned)", () => {
    const tree = [
      { type: "conversation", id: "c1", isPinned: true },
      { type: "folder", id: "f1", isPinned: true },
    ];
    const { pinned, unpinned } = splitByPinned(tree);
    expect(pinned).toEqual([{ type: "folder", id: "f1", isPinned: true }]);
    expect(unpinned).toEqual([
      { type: "conversation", id: "c1", isPinned: true },
    ]);
  });

  it("handles empty array", () => {
    const { pinned, unpinned } = splitByPinned([]);
    expect(pinned).toEqual([]);
    expect(unpinned).toEqual([]);
  });

  it("handles all pinned folders", () => {
    const tree = [
      { type: "folder", id: "f1", isPinned: true },
      { type: "folder", id: "f2", isPinned: true },
    ];
    const { pinned, unpinned } = splitByPinned(tree);
    expect(pinned).toHaveLength(2);
    expect(unpinned).toHaveLength(0);
  });
});

describe("collectTreeIds", () => {
  it("collects ids of matching type from flat list", () => {
    const nodes = [
      { type: "conversation", id: "c1" },
      { type: "folder", id: "f1" },
      { type: "conversation", id: "c2" },
    ];
    const ids = collectTreeIds(nodes, "conversation");
    expect(ids).toEqual(new Set(["c1", "c2"]));
  });

  it("collects ids from nested children", () => {
    const nodes = [
      {
        type: "folder",
        id: "f1",
        children: [
          { type: "conversation", id: "c1" },
          {
            type: "folder",
            id: "f2",
            children: [{ type: "conversation", id: "c2" }],
          },
        ],
      },
    ];
    const ids = collectTreeIds(nodes, "conversation");
    expect(ids).toEqual(new Set(["c1", "c2"]));
  });

  it("does not recurse into matching nodes (only non-matching)", () => {
    // When a node matches the type, its children are not walked
    // (based on the else-if logic in the source)
    const nodes = [
      {
        type: "conversation",
        id: "c1",
        children: [{ type: "conversation", id: "c2" }],
      },
    ];
    const ids = collectTreeIds(nodes, "conversation");
    // c1 matches, so its children are NOT walked (else if branch)
    expect(ids).toEqual(new Set(["c1"]));
  });

  it("returns empty set when no matches", () => {
    const nodes = [
      { type: "folder", id: "f1" },
      { type: "folder", id: "f2" },
    ];
    const ids = collectTreeIds(nodes, "conversation");
    expect(ids).toEqual(new Set());
  });

  it("handles empty array", () => {
    const ids = collectTreeIds([], "conversation");
    expect(ids).toEqual(new Set());
  });

  it("collects folder ids when type is folder", () => {
    const nodes = [
      {
        type: "folder",
        id: "f1",
        children: [{ type: "conversation", id: "c1" }],
      },
      { type: "conversation", id: "c2" },
    ];
    const ids = collectTreeIds(nodes, "folder");
    // f1 matches so its children are not walked
    expect(ids).toEqual(new Set(["f1"]));
  });

  it("handles deeply nested structures", () => {
    const nodes = [
      {
        type: "folder",
        id: "f1",
        children: [
          {
            type: "folder",
            id: "f2",
            children: [
              {
                type: "folder",
                id: "f3",
                children: [{ type: "conversation", id: "c1" }],
              },
            ],
          },
        ],
      },
    ];
    const ids = collectTreeIds(nodes, "conversation");
    expect(ids).toEqual(new Set(["c1"]));
  });
});

describe("collectFolders", () => {
  it("collects folders with their depth, skipping leaves", () => {
    const tree = [
      {
        type: "folder",
        id: "f1",
        name: "Work",
        children: [
          { type: "chat", id: "c1" },
          { type: "folder", id: "f2", name: "Archive" },
        ],
      },
      { type: "chat", id: "c2" },
      { type: "folder", id: "f3", name: "Personal" },
    ];
    expect(collectFolders(tree)).toEqual([
      { id: "f1", name: "Work", depth: 0 },
      { id: "f2", name: "Archive", depth: 1 },
      { id: "f3", name: "Personal", depth: 0 },
    ]);
  });

  it("returns an empty array for a tree without folders", () => {
    expect(collectFolders([{ type: "chat", id: "c1" }])).toEqual([]);
    expect(collectFolders([])).toEqual([]);
  });
});
