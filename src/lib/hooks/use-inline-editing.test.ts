import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useInlineEditing } from "./use-inline-editing";

describe("useInlineEditing", () => {
  let onRename: (id: string, name: string, type: string) => Promise<void>;

  beforeEach(() => {
    onRename = vi.fn().mockResolvedValue(undefined);
  });

  it("initializes with null/empty state", () => {
    const { result } = renderHook(() => useInlineEditing({ onRename }));
    expect(result.current.editingId).toBeNull();
    expect(result.current.editingName).toBe("");
    expect(result.current.editingType).toBeNull();
  });

  it("startEditing sets id, name, and type", () => {
    const { result } = renderHook(() => useInlineEditing({ onRename }));
    act(() => {
      result.current.startEditing("id-1", "Test Name", "folder");
    });
    expect(result.current.editingId).toBe("id-1");
    expect(result.current.editingName).toBe("Test Name");
    expect(result.current.editingType).toBe("folder");
  });

  it("startEditing defaults type to null if not provided", () => {
    const { result } = renderHook(() => useInlineEditing({ onRename }));
    act(() => {
      result.current.startEditing("id-2", "Name Only");
    });
    expect(result.current.editingId).toBe("id-2");
    expect(result.current.editingName).toBe("Name Only");
    expect(result.current.editingType).toBeNull();
  });

  it("setEditingName updates the name", () => {
    const { result } = renderHook(() => useInlineEditing({ onRename }));
    act(() => {
      result.current.startEditing("id-1", "Old Name");
    });
    act(() => {
      result.current.setEditingName("New Name");
    });
    expect(result.current.editingName).toBe("New Name");
  });

  it("handleRenameSubmit calls onRename and clears state", async () => {
    const { result } = renderHook(() => useInlineEditing({ onRename }));
    act(() => {
      result.current.startEditing("id-1", "My Item", "chat");
    });

    await act(async () => {
      await result.current.handleRenameSubmit();
    });

    expect(onRename).toHaveBeenCalledWith("id-1", "My Item", "chat");
    expect(result.current.editingId).toBeNull();
    expect(result.current.editingName).toBe("");
    expect(result.current.editingType).toBeNull();
  });

  it("handleRenameSubmit trims the name", async () => {
    const { result } = renderHook(() => useInlineEditing({ onRename }));
    act(() => {
      result.current.startEditing("id-1", "  Padded Name  ", "chat");
    });

    await act(async () => {
      await result.current.handleRenameSubmit();
    });

    expect(onRename).toHaveBeenCalledWith("id-1", "Padded Name", "chat");
  });

  it("handleRenameSubmit does nothing when editingId is null", async () => {
    const { result } = renderHook(() => useInlineEditing({ onRename }));

    await act(async () => {
      await result.current.handleRenameSubmit();
    });

    expect(onRename).not.toHaveBeenCalled();
  });

  it("handleRenameSubmit does nothing when name is whitespace-only", async () => {
    const { result } = renderHook(() => useInlineEditing({ onRename }));
    act(() => {
      result.current.startEditing("id-1", "   ");
    });

    await act(async () => {
      await result.current.handleRenameSubmit();
    });

    expect(onRename).not.toHaveBeenCalled();
  });

  it("handleRenameSubmit uses empty string when editingType is null", async () => {
    const { result } = renderHook(() => useInlineEditing({ onRename }));
    act(() => {
      result.current.startEditing("id-1", "Name");
    });

    await act(async () => {
      await result.current.handleRenameSubmit();
    });

    expect(onRename).toHaveBeenCalledWith("id-1", "Name", "");
  });

  it("handleKeyDown with Enter triggers submit", async () => {
    const { result } = renderHook(() => useInlineEditing({ onRename }));
    act(() => {
      result.current.startEditing("id-1", "Item");
    });

    await act(async () => {
      result.current.handleKeyDown({ key: "Enter" } as React.KeyboardEvent);
    });

    expect(onRename).toHaveBeenCalledWith("id-1", "Item", "");
  });

  it("handleKeyDown with Escape clears editing state", () => {
    const { result } = renderHook(() => useInlineEditing({ onRename }));
    act(() => {
      result.current.startEditing("id-1", "Item");
    });

    act(() => {
      result.current.handleKeyDown({ key: "Escape" } as React.KeyboardEvent);
    });

    expect(result.current.editingId).toBeNull();
    expect(result.current.editingName).toBe("");
    expect(onRename).not.toHaveBeenCalled();
  });

  it("handleKeyDown with other keys does nothing", () => {
    const { result } = renderHook(() => useInlineEditing({ onRename }));
    act(() => {
      result.current.startEditing("id-1", "Item");
    });

    act(() => {
      result.current.handleKeyDown({ key: "Tab" } as React.KeyboardEvent);
    });

    expect(result.current.editingId).toBe("id-1");
    expect(onRename).not.toHaveBeenCalled();
  });
});
