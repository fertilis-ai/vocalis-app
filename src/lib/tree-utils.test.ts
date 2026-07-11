import { describe, it, expect } from "vitest";
import {
  collectFromTree,
  findNodeInTree,
  getUniqueName,
  getSiblingFolderNames,
  insertNode,
  removeNode,
  updateNode,
  moveNode,
  type TreeNode,
} from "./tree-utils";

const tree: TreeNode[] = [
  { id: "f1", name: "Folder A", type: "folder", children: [
    { id: "c1", name: "Chat 1", type: "chat" },
    { id: "f2", name: "Subfolder", type: "folder", children: [
      { id: "c2", name: "Chat 2", type: "chat" },
    ] },
  ] },
  { id: "f3", name: "Folder B", type: "folder" },
  { id: "c3", name: "Chat 3", type: "chat" },
];

describe("findNodeInTree", () => {
  it("finds a root-level node", () => {
    expect(findNodeInTree(tree, "f1")?.name).toBe("Folder A");
  });

  it("finds a deeply nested node", () => {
    expect(findNodeInTree(tree, "c2")?.name).toBe("Chat 2");
  });

  it("returns null for unknown id", () => {
    expect(findNodeInTree(tree, "nonexistent")).toBeNull();
  });

  it("returns null for empty tree", () => {
    expect(findNodeInTree([], "f1")).toBeNull();
  });
});

describe("collectFromTree", () => {
  it("collects matching nodes depth-first, including nested ones", () => {
    const ids = collectFromTree(tree, (node) => (node.type === "chat" ? node.id : undefined));
    expect(ids).toEqual(["c1", "c2", "c3"]);
  });

  it("skips nodes for which visit returns undefined", () => {
    const ids = collectFromTree(tree, (node) => (node.type === "folder" ? node.id : undefined));
    expect(ids).toEqual(["f1", "f2", "f3"]);
  });

  it("returns empty array for empty tree", () => {
    expect(collectFromTree([], (node: TreeNode) => node.id)).toEqual([]);
  });

  it("returns empty array when nothing matches", () => {
    expect(collectFromTree(tree, () => undefined)).toEqual([]);
  });
});

describe("getUniqueName", () => {
  it("returns base name when no collision", () => {
    expect(getUniqueName("New Folder", ["Existing"])).toBe("New Folder");
  });

  it("appends counter on collision", () => {
    expect(getUniqueName("Folder", ["Folder"])).toBe("Folder 2");
  });

  it("increments counter until unique", () => {
    expect(getUniqueName("Folder", ["Folder", "Folder 2", "Folder 3"])).toBe("Folder 4");
  });

  it("handles empty existing names", () => {
    expect(getUniqueName("Folder", [])).toBe("Folder");
  });
});

describe("getSiblingFolderNames", () => {
  it("returns root-level folder names when no parent", () => {
    expect(getSiblingFolderNames(tree)).toEqual(["Folder A", "Folder B"]);
  });

  it("returns child folder names for a parent", () => {
    expect(getSiblingFolderNames(tree, "f1")).toEqual(["Subfolder"]);
  });

  it("returns empty array for leaf node parent", () => {
    expect(getSiblingFolderNames(tree, "c1")).toEqual([]);
  });

  it("returns empty array for unknown parent", () => {
    expect(getSiblingFolderNames(tree, "nonexistent")).toEqual([]);
  });
});

const leaf = (id: string, name = id): TreeNode => ({ id, name, type: "chat" });
const folder = (id: string, children: TreeNode[] = []): TreeNode => ({
  id,
  name: id,
  type: "folder",
  children,
});

describe("insertNode", () => {
  it("appends at root when no parent given", () => {
    const next = insertNode([leaf("a")], leaf("b"));
    expect(next.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("inserts under the named folder", () => {
    const next = insertNode([folder("f1")], leaf("c1"), "f1");
    expect(findNodeInTree(next, "f1")?.children?.map((n) => n.id)).toEqual(["c1"]);
  });

  it("inserts under a deeply nested folder", () => {
    const next = insertNode([folder("f1", [folder("f2")])], leaf("c1"), "f2");
    expect(findNodeInTree(next, "f2")?.children?.map((n) => n.id)).toEqual(["c1"]);
  });

  it("falls back to root when the parent is missing", () => {
    const next = insertNode([folder("f1")], leaf("c1"), "nope");
    expect(next.map((n) => n.id)).toEqual(["f1", "c1"]);
  });

  it("does not mutate the input tree", () => {
    const input = [folder("f1")];
    insertNode(input, leaf("c1"), "f1");
    expect(findNodeInTree(input, "f1")?.children ?? []).toEqual([]);
  });
});

describe("removeNode", () => {
  it("removes a root-level node", () => {
    expect(removeNode([leaf("a"), leaf("b")], "a").map((n) => n.id)).toEqual(["b"]);
  });

  it("removes a nested node and its subtree", () => {
    const next = removeNode([folder("f1", [folder("f2", [leaf("c1")])])], "f2");
    expect(findNodeInTree(next, "f2")).toBeNull();
    expect(findNodeInTree(next, "c1")).toBeNull();
  });

  it("is a no-op for unknown id", () => {
    expect(removeNode([leaf("a")], "x").map((n) => n.id)).toEqual(["a"]);
  });
});

describe("updateNode", () => {
  it("patches the matching node only", () => {
    const next = updateNode([leaf("a"), leaf("b")], "b", (n) => ({ ...n, name: "renamed" }));
    expect(findNodeInTree(next, "b")?.name).toBe("renamed");
    expect(findNodeInTree(next, "a")?.name).toBe("a");
  });

  it("patches a nested node", () => {
    const next = updateNode([folder("f1", [leaf("c1")])], "c1", (n) => ({
      ...n,
      name: "renamed",
    }));
    expect(findNodeInTree(next, "c1")?.name).toBe("renamed");
  });
});

describe("moveNode", () => {
  it("moves a leaf into a folder", () => {
    const next = moveNode([folder("f1"), leaf("c1")], "c1", "f1");
    expect(next.map((n) => n.id)).toEqual(["f1"]);
    expect(findNodeInTree(next, "f1")?.children?.map((n) => n.id)).toEqual(["c1"]);
  });

  it("moves a leaf back to root", () => {
    const next = moveNode([folder("f1", [leaf("c1")])], "c1", null);
    expect(findNodeInTree(next, "f1")?.children ?? []).toEqual([]);
    expect(next.map((n) => n.id)).toEqual(["f1", "c1"]);
  });

  it("refuses to move a folder into its own descendant", () => {
    const input = [folder("f1", [folder("f2")])];
    expect(moveNode(input, "f1", "f2")).toBe(input);
  });

  it("is a no-op for a missing node", () => {
    const input = [folder("f1")];
    expect(moveNode(input, "nope", "f1")).toBe(input);
  });
});
