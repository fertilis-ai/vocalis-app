import { z } from "zod";

// The sidebar tree shared by all sidebar-organized collections (spec §3.6):
// chats/sessions now, voices/presets later. Persisted as one tree.json per
// collection (e.g. chats/tree.json). Leaf nodes only reference items by id +
// `kind`; the item content lives in its own file, owned by a feature store.
// This is the one tree abstraction that fixes Sapio's storage triplication.

export interface CollectionTreeNode {
  id: string;
  name: string;
  type: "folder" | "leaf";
  /** Leaf discriminator (e.g. "session" | "chat"); tells the caller where the item lives. Absent on folders. */
  kind?: string;
  isPinned?: boolean;
  createdAt: string;
  children?: CollectionTreeNode[];
}

export const collectionTreeNodeSchema: z.ZodType<CollectionTreeNode> = z.lazy(
  () =>
    z.object({
      id: z.string().min(1),
      name: z.string(),
      type: z.enum(["folder", "leaf"]),
      kind: z.string().optional(),
      isPinned: z.boolean().optional(),
      createdAt: z.string().datetime(),
      children: z.array(collectionTreeNodeSchema).optional(),
    }),
);

export const collectionTreeSchema = z.array(collectionTreeNodeSchema);
