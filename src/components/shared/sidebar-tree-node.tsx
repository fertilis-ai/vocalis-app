import type * as React from "react";
import {
  Plus,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FolderContextMenu, LeafContextMenu, type MoveTarget } from "@/components/shared/item-context-menu";

export interface SidebarTreeNodeData {
  type: string;
  id: string;
  name: string;
  /** Leaf discriminator, when a collection mixes leaf kinds. */
  kind?: string;
  isPinned?: boolean;
  children?: SidebarTreeNodeData[];
  title?: string;
}

interface SidebarTreeNodeProps {
  node: SidebarTreeNodeData;
  depth: number;
  selectedItemId: string | null;
  expandedFolders: Set<string>;
  editingId: string | null;
  editingName: string;
  /** A node icon, or a resolver when leaf kinds have distinct icons. */
  leafIcon: React.ReactNode | ((node: SidebarTreeNodeData) => React.ReactNode);
  leafType: string;
  createInFolderTitle: string;
  onSelect: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onCreateInFolder: (folderId: string) => void;
  onStartEditing: (id: string, name: string, type: string) => void;
  onEditingNameChange: (name: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onRenameSubmit: () => void;
  onDeleteFolder: (id: string) => void;
  onDeleteLeaf: (id: string) => void;
  onTogglePin: (id: string) => void;
  getDisplayName: (node: SidebarTreeNodeData) => string;
  /** Destination folders for "Move to folder" on leaves; omit to hide the action. */
  moveTargets?: MoveTarget[];
  onMoveLeaf?: (id: string, targetFolderId: string | null) => void;
  /** Folder id containing this node; undefined at the root. */
  parentFolderId?: string;
}

export function SidebarTreeNode({
  node,
  depth,
  selectedItemId,
  expandedFolders,
  editingId,
  editingName,
  leafIcon,
  leafType,
  createInFolderTitle,
  onSelect,
  onToggleExpand,
  onCreateInFolder,
  onStartEditing,
  onEditingNameChange,
  onKeyDown,
  onRenameSubmit,
  onDeleteFolder,
  onDeleteLeaf,
  onTogglePin,
  getDisplayName,
  moveTargets,
  onMoveLeaf,
  parentFolderId,
}: SidebarTreeNodeProps) {
  const isFolder = node.type === "folder";
  const isExpanded = expandedFolders.has(node.id);
  const isEditing = editingId === node.id;
  const isSelected = !isFolder && selectedItemId === node.id;
  const baseIndent = 8;
  const indentStep = 24;
  const paddingLeft = `${baseIndent + depth * indentStep}px`;

  const displayName = getDisplayName(node);

  if (isFolder) {
    return (
      <div>
        <div
          className="group flex items-center gap-1 rounded-sm px-2 py-1.5 text-sm cursor-pointer hover:bg-muted"
          style={{ paddingLeft }}
        >
          <button
            className="flex-shrink-0 p-0.5 hover:bg-muted-foreground/10 rounded"
            onClick={() => onToggleExpand(node.id)}
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 transition-transform",
                isExpanded && "rotate-90"
              )}
            />
          </button>

          {isEditing ? (
            <input
              type="text"
              value={editingName}
              onChange={(e) => onEditingNameChange(e.target.value)}
              onKeyDown={onKeyDown}
              onBlur={onRenameSubmit}
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 bg-transparent border-b border-primary outline-none text-sm"
            />
          ) : (
            <span
              className="flex-1 truncate"
              onClick={() => onToggleExpand(node.id)}
            >
              {displayName}
            </span>
          )}

          {/* Hover actions */}
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
            <Button
              variant="ghost"
              size="icon-xs"
              className="h-5 w-5"
              onClick={(e) => {
                e.stopPropagation();
                if (!isExpanded) {
                  onToggleExpand(node.id);
                }
                onCreateInFolder(node.id);
              }}
              title={createInFolderTitle}
            >
              <Plus className="h-3 w-3" />
            </Button>
            <FolderContextMenu
              isPinned={!!node.isPinned}
              onRename={() => onStartEditing(node.id, node.name, "folder")}
              onDelete={() => onDeleteFolder(node.id)}
              onTogglePin={() => onTogglePin(node.id)}
            />
          </div>
        </div>

        {/* Children */}
        {isExpanded && node.children && (
          <div>
            {node.children.map((child) => (
              <SidebarTreeNode
                key={child.id}
                node={child}
                depth={depth + 1}
                selectedItemId={selectedItemId}
                expandedFolders={expandedFolders}
                editingId={editingId}
                editingName={editingName}
                leafIcon={leafIcon}
                leafType={leafType}
                createInFolderTitle={createInFolderTitle}
                onSelect={onSelect}
                onToggleExpand={onToggleExpand}
                onCreateInFolder={onCreateInFolder}
                onStartEditing={onStartEditing}
                onEditingNameChange={onEditingNameChange}
                onKeyDown={onKeyDown}
                onRenameSubmit={onRenameSubmit}
                onDeleteFolder={onDeleteFolder}
                onDeleteLeaf={onDeleteLeaf}
                onTogglePin={onTogglePin}
                getDisplayName={getDisplayName}
                moveTargets={moveTargets}
                onMoveLeaf={onMoveLeaf}
                parentFolderId={node.id}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Leaf item
  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer hover:bg-muted",
        isSelected && "bg-muted"
      )}
      style={{ paddingLeft }}
      onClick={() => onSelect(node.id)}
    >
      {typeof leafIcon === "function" ? leafIcon(node) : leafIcon}

      {isEditing ? (
        <input
          type="text"
          value={editingName}
          onChange={(e) => onEditingNameChange(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onRenameSubmit}
          autoFocus
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="flex-1 bg-transparent border-b border-primary outline-none text-sm"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="flex-1 truncate">{displayName}</span>
      )}

      {/* Hover actions */}
      <div className="flex items-center opacity-0 group-hover:opacity-100">
        <LeafContextMenu
          onRename={() => onStartEditing(node.id, displayName, leafType)}
          onDelete={() => onDeleteLeaf(node.id)}
          moveTargets={
            onMoveLeaf
              ? moveTargets?.filter((t) => (t.id ?? undefined) !== parentFolderId)
              : undefined
          }
          onMove={onMoveLeaf ? (folderId) => onMoveLeaf(node.id, folderId) : undefined}
        />
      </div>
    </div>
  );
}
