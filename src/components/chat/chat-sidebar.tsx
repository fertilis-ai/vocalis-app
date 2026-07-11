import * as React from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AudioLines, FileAudio, MessageSquare, Plus, FolderPlus } from "lucide-react";
import { toast } from "sonner";
import { ImportDialog } from "@/components/chat/import-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarTreeNode,
  type SidebarTreeNodeData,
} from "@/components/shared/sidebar-tree-node";
import type { MoveTarget } from "@/components/shared/item-context-menu";
import { collectFromTree, findNodeInTree, getUniqueName } from "@/lib/tree-utils";
import type { CollectionTreeNode } from "@/lib/schemas/collection";
import { useChatStore } from "@/stores/chat-store";
import { useChatsCollection } from "@/stores/chats-collection";
import { useSessionStore } from "@/stores/session-store";

// Sidebar for the chat section: one tree mixing transcription sessions and
// (M4) voice chats. New-flow distinguishes the two kinds with distinct icons.

/** Pinned first, then newest first — recursively, without mutating store order. */
function sortForDisplay(nodes: CollectionTreeNode[]): CollectionTreeNode[] {
  return [...nodes]
    .sort((a, b) => {
      if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt);
    })
    .map((n) => (n.children ? { ...n, children: sortForDisplay(n.children) } : n));
}

function leafIcon(node: SidebarTreeNodeData): React.ReactNode {
  const Icon = node.kind === "chat" ? MessageSquare : AudioLines;
  return <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />;
}

export function ChatSidebar() {
  const store = useChatsCollection();
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editingName, setEditingName] = React.useState("");
  const [importFile, setImportFile] = React.useState<string | null>(null);

  React.useEffect(() => {
    void store.load();
  }, [store.load]);

  const tree = React.useMemo(() => sortForDisplay(store.tree), [store.tree]);

  const leafNames = React.useMemo(
    () =>
      collectFromTree(store.tree, (n) => (n.type === "leaf" ? n.name : undefined)),
    [store.tree],
  );

  const moveTargets = React.useMemo<MoveTarget[]>(() => {
    const targets: MoveTarget[] = [{ id: null, name: "(top level)", depth: 0 }];
    const walk = (nodes: CollectionTreeNode[], depth: number) => {
      for (const n of nodes) {
        if (n.type === "folder") {
          targets.push({ id: n.id, name: n.name, depth: depth + 1 });
          if (n.children) walk(n.children, depth + 1);
        }
      }
    };
    walk(tree, 0);
    return targets;
  }, [tree]);

  async function createSessionLeaf(parentFolderId?: string | null) {
    const title = getUniqueName("New session", leafNames);
    const node = await store.createLeaf("session", title, parentFolderId);
    await useSessionStore.getState().createSession({
      id: node.id,
      title,
      mode: "live",
    });
    store.select(node.id);
  }

  async function createChatLeaf() {
    const title = getUniqueName("New chat", leafNames);
    const node = await store.createLeaf("chat", title);
    await useChatStore.getState().createConversation({ id: node.id, title });
    store.select(node.id);
  }

  async function createFolder() {
    const name = getUniqueName("New folder", leafNames);
    await store.createFolder(name);
  }

  async function pickImportFile() {
    const selected = await open({
      multiple: false,
      filters: [
        { name: "Audio", extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg"] },
      ],
    });
    if (typeof selected === "string") setImportFile(selected);
  }

  async function handleDelete(id: string) {
    try {
      await store.remove(id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  function startEditing(id: string, name: string) {
    setEditingId(id);
    setEditingName(name);
  }

  async function submitRename() {
    if (editingId && editingName.trim()) {
      const name = editingName.trim();
      await store.rename(editingId, name);
      // Keep the session's own title in sync with the tree label (the header
      // and exports read session.title).
      const node = findNodeInTree(store.tree, editingId);
      if (node?.kind === "session") {
        await useSessionStore.getState().updateSession(editingId, { title: name });
      } else if (node?.kind === "chat") {
        await useChatStore.getState().updateConversation(editingId, { title: name });
      }
    }
    setEditingId(null);
    setEditingName("");
  }

  function onEditKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") void submitRename();
    else if (e.key === "Escape") {
      setEditingId(null);
      setEditingName("");
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Chat
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-xs" className="h-6 w-6" />}
          >
            <Plus className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => void createSessionLeaf()}>
              <AudioLines className="mr-2 h-4 w-4" />
              Transcription session
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void createChatLeaf()}>
              <MessageSquare className="mr-2 h-4 w-4" />
              Voice chat
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void pickImportFile()}>
              <FileAudio className="mr-2 h-4 w-4" />
              Import audio file…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void createFolder()}>
              <FolderPlus className="mr-2 h-4 w-4" />
              New folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex-1 overflow-y-auto pb-2">
        {tree.length === 0 ? (
          <p className="px-3 py-4 text-muted-foreground text-xs">
            No sessions yet. Use + to start one.
          </p>
        ) : (
          tree.map((node) => (
            <SidebarTreeNode
              key={node.id}
              node={node}
              depth={0}
              selectedItemId={store.selectedId}
              expandedFolders={store.expandedFolders}
              editingId={editingId}
              editingName={editingName}
              leafIcon={leafIcon}
              leafType="session"
              createInFolderTitle="New session in folder"
              onSelect={store.select}
              onToggleExpand={store.toggleExpand}
              onCreateInFolder={(folderId) => void createSessionLeaf(folderId)}
              onStartEditing={(id, name) => startEditing(id, name)}
              onEditingNameChange={setEditingName}
              onKeyDown={onEditKeyDown}
              onRenameSubmit={() => void submitRename()}
              onDeleteFolder={(id) => void handleDelete(id)}
              onDeleteLeaf={(id) => void handleDelete(id)}
              onTogglePin={(id) => void store.togglePin(id)}
              getDisplayName={(n) => n.name}
              moveTargets={moveTargets}
              onMoveLeaf={(id, folderId) => void store.move(id, folderId)}
            />
          ))
        )}
      </div>

      {importFile && (
        <ImportDialog filePath={importFile} onClose={() => setImportFile(null)} />
      )}
    </div>
  );
}
