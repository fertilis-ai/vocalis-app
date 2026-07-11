import * as React from "react";

interface UseInlineEditingOptions {
  onRename: (id: string, name: string, type: string) => Promise<void>;
}

export function useInlineEditing({ onRename }: UseInlineEditingOptions) {
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editingName, setEditingName] = React.useState("");
  const [editingType, setEditingType] = React.useState<string | null>(null);

  const startEditing = (id: string, name: string, type?: string) => {
    setEditingId(id);
    setEditingName(name);
    setEditingType(type ?? null);
  };

  const clearEditing = () => {
    setEditingId(null);
    setEditingName("");
    setEditingType(null);
  };

  const handleRenameSubmit = async () => {
    if (!editingId || !editingName.trim()) return;
    await onRename(editingId, editingName.trim(), editingType ?? "");
    clearEditing();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleRenameSubmit();
    } else if (e.key === "Escape") {
      clearEditing();
    }
  };

  return {
    editingId,
    editingName,
    editingType,
    startEditing,
    setEditingName,
    handleRenameSubmit,
    handleKeyDown,
  };
}
