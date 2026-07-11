interface TreeNode {
  type: string;
  id: string;
  name?: string;
  isPinned?: boolean;
  children?: TreeNode[];
}

export function splitByPinned<T extends TreeNode>(tree: T[]) {
  const pinned = tree.filter((n) => n.type === "folder" && n.isPinned) as T[];
  const unpinned = tree.filter((n) => !(n.type === "folder" && n.isPinned)) as T[];
  return { pinned, unpinned };
}

export function collectTreeIds(nodes: TreeNode[], type: string): Set<string> {
  const ids = new Set<string>();
  const walk = (items: TreeNode[]) => {
    for (const node of items) {
      if (node.type === type) {
        ids.add(node.id);
      } else if (node.children) {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return ids;
}

/** Flatten all folders in the tree (depth-first) with their nesting depth. */
export function collectFolders(nodes: TreeNode[]): Array<{ id: string; name: string; depth: number }> {
  const folders: Array<{ id: string; name: string; depth: number }> = [];
  const walk = (items: TreeNode[], depth: number) => {
    for (const node of items) {
      if (node.type === "folder") {
        folders.push({ id: node.id, name: node.name ?? node.id, depth });
        if (node.children) walk(node.children, depth + 1);
      }
    }
  };
  walk(nodes, 0);
  return folders;
}
