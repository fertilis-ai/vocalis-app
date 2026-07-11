import { v4 as uuid } from "uuid";
import { create, type UseBoundStore, type StoreApi } from "zustand";
import {
  type CollectionTreeNode,
  collectionTreeSchema,
} from "@/lib/schemas/collection";
import {
  collectFromTree,
  insertNode,
  moveNode,
  removeNode,
  updateNode,
} from "@/lib/tree-utils";
import { readFile, writeFile } from "@/lib/storage";
import { serialize } from "@/lib/write-queue";

// Generic sidebar-tree store (spec §3.6): tree + CRUD + pinning + rename +
// move + disk sync, parameterized by a tree.json path and an optional leaf
// cleanup hook. One instance per collection (chats/sessions, voices, …). Leaf
// item content is owned by a feature store — this only tracks the tree.

export interface CollectionStoreConfig {
  /** Path to this collection's tree file, e.g. "chats/tree.json". */
  treePath: string;
  /**
   * Delete a leaf's backing files when it (or an enclosing folder) is removed.
   * Called once per removed leaf with its id and `kind`.
   */
  onDeleteLeaf?: (id: string, kind: string) => Promise<void>;
  /**
   * Checked for every leaf that would be removed (itself, or contained in a
   * removed folder) before anything is deleted. Return a reason string to
   * block the whole removal — the tree and disk are left untouched — or null
   * to allow it.
   */
  guardDeleteLeaf?: (id: string, kind: string) => string | null;
}

export interface CollectionState {
  tree: CollectionTreeNode[];
  loaded: boolean;
  /**
   * Set when the tree file existed but failed to parse/validate. A backup was
   * written to `<treePath>.bak`; every mutation is refused until the app is
   * restarted (after the file is fixed or removed) so nothing overwrites it.
   */
  corrupt: boolean;
  /** Selected leaf id (session-only, not persisted). */
  selectedId: string | null;
  /** Expanded folder ids (session-only, not persisted). */
  expandedFolders: Set<string>;

  load: () => Promise<void>;
  select: (id: string | null) => void;
  toggleExpand: (id: string) => void;

  /** Create a leaf; returns the node so the caller can create its item file with the same id. */
  createLeaf: (
    kind: string,
    name: string,
    parentFolderId?: string | null,
  ) => Promise<CollectionTreeNode>;
  createFolder: (
    name: string,
    parentFolderId?: string | null,
  ) => Promise<CollectionTreeNode>;
  rename: (id: string, name: string) => Promise<void>;
  /** Remove a node; folders recurse, calling onDeleteLeaf for each contained leaf. */
  remove: (id: string) => Promise<void>;
  move: (id: string, targetFolderId: string | null) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
}

export function createCollectionStore(
  config: CollectionStoreConfig,
): UseBoundStore<StoreApi<CollectionState>> {
  return create<CollectionState>()((set, get) => {
    function assertNotCorrupt(): void {
      if (get().corrupt) {
        throw new Error(
          `${config.treePath} was corrupt and has been backed up to ${config.treePath}.bak. ` +
            "Fix or remove it and restart the app before making further changes here.",
        );
      }
    }

    // Persist a tree, then apply the state change atomically so state and disk
    // never diverge on a write failure.
    async function writeTree(tree: CollectionTreeNode[]): Promise<void> {
      await writeFile(config.treePath, JSON.stringify(tree, null, 2));
      set({ tree });
    }

    // Serialized per tree file: `compute` reads the latest committed tree (not
    // a snapshot taken before an earlier concurrent mutation's write landed),
    // so two overlapping mutations can't compute from the same stale tree and
    // have one clobber the other's change on write (spec M8).
    function commit(
      compute: (tree: CollectionTreeNode[]) => CollectionTreeNode[],
    ): Promise<void> {
      return serialize(config.treePath, async () => {
        assertNotCorrupt();
        await writeTree(compute(get().tree));
      });
    }

    // Reveal a folder so a freshly created child is visible.
    function expand(folderId: string): void {
      set((state) => ({
        expandedFolders: new Set(state.expandedFolders).add(folderId),
      }));
    }

    return {
      tree: [],
      loaded: false,
      corrupt: false,
      selectedId: null,
      expandedFolders: new Set<string>(),

      load: async () => {
        if (get().loaded) return;
        set({ loaded: true });
        let raw: string;
        try {
          raw = await readFile(config.treePath);
        } catch {
          // No file yet (first run) or otherwise unreadable — start empty;
          // the first mutation will create it.
          return;
        }
        if (!raw) return;
        try {
          set({ tree: collectionTreeSchema.parse(JSON.parse(raw)) });
        } catch (err) {
          console.error(
            `[collection] corrupt tree ${config.treePath}, quarantining:`,
            err,
          );
          await writeFile(`${config.treePath}.bak`, raw).catch(() => {});
          set({ corrupt: true });
        }
      },

      select: (id) => set({ selectedId: id }),

      toggleExpand: (id) =>
        set((state) => {
          const next = new Set(state.expandedFolders);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return { expandedFolders: next };
        }),

      createLeaf: async (kind, name, parentFolderId) => {
        const node: CollectionTreeNode = {
          id: uuid(),
          name,
          type: "leaf",
          kind,
          createdAt: new Date().toISOString(),
        };
        await commit((tree) => insertNode(tree, node, parentFolderId));
        if (parentFolderId) expand(parentFolderId);
        return node;
      },

      createFolder: async (name, parentFolderId) => {
        const node: CollectionTreeNode = {
          id: uuid(),
          name,
          type: "folder",
          createdAt: new Date().toISOString(),
          children: [],
        };
        await commit((tree) => insertNode(tree, node, parentFolderId));
        if (parentFolderId) expand(parentFolderId);
        return node;
      },

      rename: async (id, name) => {
        await commit((tree) => updateNode(tree, id, (n) => ({ ...n, name })));
      },

      remove: async (id) => {
        // Guard check, write, and selection cleanup all run against the
        // freshest tree inside the same serialized slot as other mutations.
        const leaves = await serialize(config.treePath, async () => {
          assertNotCorrupt();
          const tree = get().tree;
          const target = collectFromTree(tree, (n) => (n.id === id ? n : undefined))[0];
          if (!target) return null;
          // Gather every leaf about to disappear (the node itself, or its subtree).
          const leaves =
            target.type === "leaf"
              ? [target]
              : collectFromTree(target.children ?? [], (n) =>
                  n.type === "leaf" ? n : undefined,
                );
          if (config.guardDeleteLeaf) {
            for (const leaf of leaves) {
              const reason = config.guardDeleteLeaf(leaf.id, leaf.kind ?? "");
              if (reason) throw new Error(reason);
            }
          }
          await writeTree(removeNode(tree, id));
          if (get().selectedId && !collectFromTree(get().tree, (n) => (n.id === get().selectedId ? n : undefined)).length) {
            set({ selectedId: null });
          }
          return leaves;
        });
        if (!leaves) return;
        // Backing-file cleanup can be slow; run it outside the tree write
        // queue so it doesn't hold up unrelated sidebar mutations.
        if (config.onDeleteLeaf) {
          const results = await Promise.allSettled(
            leaves.map((leaf) => config.onDeleteLeaf?.(leaf.id, leaf.kind ?? "")),
          );
          const failed = results.filter((r) => r.status === "rejected").length;
          if (failed > 0) {
            throw new Error(
              `Removed from the sidebar, but failed to delete ${failed} file${failed === 1 ? "" : "s"} on disk.`,
            );
          }
        }
      },

      move: async (id, targetFolderId) => {
        await commit((tree) => moveNode(tree, id, targetFolderId));
      },

      togglePin: async (id) => {
        await commit((tree) =>
          updateNode(tree, id, (n) => ({ ...n, isPinned: !n.isPinned })),
        );
      },
    };
  });
}
