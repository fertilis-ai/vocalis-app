/** Minimal shape required for tree traversal. */
export interface TreeNode {
  id: string;
  name: string;
  type: string;
  children?: TreeNode[];
}

/** Find a node by ID in a recursive tree. */
export function findNodeInTree<T extends TreeNode>(tree: T[], id: string): T | null {
  for (const node of tree) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findNodeInTree(node.children as T[], id);
      if (found) return found;
    }
  }
  return null;
}

/** Walk a recursive tree depth-first, collecting the defined results of `visit`. */
export function collectFromTree<T extends { children?: T[] }, R>(
  nodes: T[],
  visit: (node: T) => R | undefined
): R[] {
  const results: R[] = [];
  for (const node of nodes) {
    const value = visit(node);
    if (value !== undefined) results.push(value);
    if (node.children) {
      results.push(...collectFromTree(node.children, visit));
    }
  }
  return results;
}

/** Return `baseName` if unique, otherwise append " 2", " 3", etc. */
export function getUniqueName(baseName: string, existingNames: string[]): string {
  if (!existingNames.includes(baseName)) return baseName;
  let counter = 2;
  let candidate = `${baseName} ${counter}`;
  while (existingNames.includes(candidate)) {
    counter += 1;
    candidate = `${baseName} ${counter}`;
  }
  return candidate;
}

/**
 * Insert `node` under `parentFolderId` (or at root when null/undefined),
 * returning a new tree. If the parent isn't found, the node is appended at
 * root so callers never silently drop it.
 */
export function insertNode<T extends TreeNode>(
  tree: T[],
  node: T,
  parentFolderId?: string | null
): T[] {
  if (!parentFolderId) return [...tree, node];
  return tryInsertNode(tree, node, parentFolderId) ?? [...tree, node];
}

/** Recursive helper: insert under the folder, or return null if it isn't found. */
function tryInsertNode<T extends TreeNode>(
  tree: T[],
  node: T,
  parentFolderId: string
): T[] | null {
  let found = false;
  const next = tree.map((n) => {
    if (n.id === parentFolderId && n.type === "folder") {
      found = true;
      return { ...n, children: [...(n.children ?? []), node] } as T;
    }
    if (n.children) {
      const children = tryInsertNode(n.children as T[], node, parentFolderId);
      if (children) {
        found = true;
        return { ...n, children } as T;
      }
    }
    return n;
  });
  return found ? next : null;
}

/** Remove the node with `id` (and its subtree), returning a new tree. */
export function removeNode<T extends TreeNode>(tree: T[], id: string): T[] {
  return tree
    .filter((n) => n.id !== id)
    .map((n) =>
      n.children ? ({ ...n, children: removeNode(n.children as T[], id) } as T) : n
    );
}

/** Apply `patch` to the node with `id`, returning a new tree. */
export function updateNode<T extends TreeNode>(
  tree: T[],
  id: string,
  patch: (node: T) => T
): T[] {
  return tree.map((n) => {
    if (n.id === id) return patch(n);
    if (n.children) return { ...n, children: updateNode(n.children as T[], id, patch) } as T;
    return n;
  });
}

/**
 * Move the node with `id` under `targetFolderId` (or root when null).
 * No-op if the node is missing or the target is inside the moved subtree.
 */
export function moveNode<T extends TreeNode>(
  tree: T[],
  id: string,
  targetFolderId: string | null
): T[] {
  const node = findNodeInTree(tree, id);
  if (!node) return tree;
  // Guard against moving a folder into its own descendant.
  if (targetFolderId && (node.id === targetFolderId || findNodeInTree(node.children as T[] ?? [], targetFolderId))) {
    return tree;
  }
  return insertNode(removeNode(tree, id), node, targetFolderId);
}

/** Get the names of sibling folders under a parent (or at root level). */
export function getSiblingFolderNames<T extends TreeNode>(tree: T[], parentFolderId?: string): string[] {
  if (!parentFolderId) {
    return tree
      .filter((node) => node.type === "folder")
      .map((node) => node.name);
  }
  const parent = findNodeInTree(tree, parentFolderId);
  if (parent?.type === "folder" && parent.children) {
    return parent.children
      .filter((node) => node.type === "folder")
      .map((node) => node.name);
  }
  return [];
}
