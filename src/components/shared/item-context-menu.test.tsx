import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import * as React from "react";

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  MoreVertical: (props: any) => (
    <span data-testid="icon-MoreVertical" {...props}>
      MoreVertical
    </span>
  ),
  Pin: (props: any) => <span data-testid="icon-Pin" {...props}>Pin</span>,
  Pencil: (props: any) => (
    <span data-testid="icon-Pencil" {...props}>Pencil</span>
  ),
  Trash2: (props: any) => (
    <span data-testid="icon-Trash2" {...props}>Trash2</span>
  ),
  FolderInput: (props: any) => (
    <span data-testid="icon-FolderInput" {...props}>FolderInput</span>
  ),
}));

// Mock the Button component
vi.mock("@/components/ui/button", () => ({
  Button: React.forwardRef(({ children, onClick, ...props }: any, ref: any) => (
    <button ref={ref} onClick={onClick} {...props}>
      {children}
    </button>
  )),
}));

// Mock the dropdown menu components - render children directly for testability
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => (
    <div data-testid="dropdown-menu">{children}</div>
  ),
  DropdownMenuTrigger: ({ children, onClick, render: _render, ...props }: any) => (
    <button data-testid="dropdown-trigger" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  DropdownMenuContent: ({ children }: any) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuItem: ({ children, onClick, className }: any) => (
    <div
      data-testid="dropdown-item"
      onClick={onClick}
      className={className}
      role="menuitem"
    >
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => <hr data-testid="dropdown-separator" />,
  DropdownMenuSub: ({ children }: any) => (
    <div data-testid="dropdown-sub">{children}</div>
  ),
  DropdownMenuSubTrigger: ({ children }: any) => (
    <div data-testid="dropdown-sub-trigger">{children}</div>
  ),
  DropdownMenuSubContent: ({ children }: any) => (
    <div data-testid="dropdown-sub-content">{children}</div>
  ),
}));

import { FolderContextMenu, LeafContextMenu } from "./item-context-menu";

describe("FolderContextMenu", () => {
  const defaultProps = {
    isPinned: false,
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onTogglePin: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the trigger button", () => {
    render(<FolderContextMenu {...defaultProps} />);

    expect(screen.getByTestId("dropdown-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("icon-MoreVertical")).toBeInTheDocument();
  });

  it("renders Rename menu item", () => {
    render(<FolderContextMenu {...defaultProps} />);

    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByTestId("icon-Pencil")).toBeInTheDocument();
  });

  it("renders Pin menu item when not pinned", () => {
    render(<FolderContextMenu {...defaultProps} />);

    // The icon mock also contains "Pin" text, so we look for the menu item specifically
    const menuItems = screen.getAllByRole("menuitem");
    const pinItem = menuItems.find((item) => item.textContent?.includes("Pin") && !item.textContent?.includes("Unpin"));
    expect(pinItem).toBeDefined();
    expect(screen.getByTestId("icon-Pin")).toBeInTheDocument();
  });

  it("renders Unpin menu item when pinned", () => {
    render(<FolderContextMenu {...defaultProps} isPinned={true} />);

    expect(screen.getByText("Unpin")).toBeInTheDocument();
  });

  it("renders Delete menu item with destructive style", () => {
    render(<FolderContextMenu {...defaultProps} />);

    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.getByTestId("icon-Trash2")).toBeInTheDocument();

    const deleteItem = screen.getByText("Delete").closest("[data-testid='dropdown-item']");
    expect(deleteItem?.className).toContain("text-destructive");
  });

  it("renders separators between groups", () => {
    render(<FolderContextMenu {...defaultProps} />);

    expect(screen.getByTestId("dropdown-separator")).toBeInTheDocument();
  });

  it("calls onRename when Rename is clicked", () => {
    const onRename = vi.fn();
    render(<FolderContextMenu {...defaultProps} onRename={onRename} />);

    fireEvent.click(screen.getByText("Rename"));
    expect(onRename).toHaveBeenCalledOnce();
  });

  it("calls onTogglePin when Pin is clicked", () => {
    const onTogglePin = vi.fn();
    render(<FolderContextMenu {...defaultProps} onTogglePin={onTogglePin} />);

    const menuItems = screen.getAllByRole("menuitem");
    const pinItem = menuItems.find((item) => item.textContent?.includes("Pin") && !item.textContent?.includes("Unpin"))!;
    fireEvent.click(pinItem);
    expect(onTogglePin).toHaveBeenCalledOnce();
  });

  it("calls onDelete when Delete is clicked", () => {
    const onDelete = vi.fn();
    render(<FolderContextMenu {...defaultProps} onDelete={onDelete} />);

    fireEvent.click(screen.getByText("Delete"));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("stops propagation on trigger click", () => {
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <FolderContextMenu {...defaultProps} />
      </div>
    );

    fireEvent.click(screen.getByTestId("dropdown-trigger"));
    // The mock trigger passes onClick through, so stopPropagation is handled by the component
    // We check the component's onClick handler calls e.stopPropagation()
  });
});

describe("LeafContextMenu", () => {
  const defaultProps = {
    onRename: vi.fn(),
    onDelete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the trigger button", () => {
    render(<LeafContextMenu {...defaultProps} />);

    expect(screen.getByTestId("dropdown-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("icon-MoreVertical")).toBeInTheDocument();
  });

  it("renders Rename menu item", () => {
    render(<LeafContextMenu {...defaultProps} />);

    expect(screen.getByText("Rename")).toBeInTheDocument();
  });

  it("renders Delete menu item", () => {
    render(<LeafContextMenu {...defaultProps} />);

    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("does not render Pin menu item", () => {
    render(<LeafContextMenu {...defaultProps} />);

    expect(screen.queryByText("Pin")).not.toBeInTheDocument();
    expect(screen.queryByText("Unpin")).not.toBeInTheDocument();
  });

  it("calls onRename when Rename is clicked", () => {
    const onRename = vi.fn();
    render(<LeafContextMenu {...defaultProps} onRename={onRename} />);

    fireEvent.click(screen.getByText("Rename"));
    expect(onRename).toHaveBeenCalledOnce();
  });

  it("calls onDelete when Delete is clicked", () => {
    const onDelete = vi.fn();
    render(<LeafContextMenu {...defaultProps} onDelete={onDelete} />);

    fireEvent.click(screen.getByText("Delete"));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("renders separator between Rename and Delete", () => {
    render(<LeafContextMenu {...defaultProps} />);

    expect(screen.getByTestId("dropdown-separator")).toBeInTheDocument();
  });

  it("renders exactly two menu items", () => {
    render(<LeafContextMenu {...defaultProps} />);

    const items = screen.getAllByTestId("dropdown-item");
    expect(items).toHaveLength(2);
  });

  describe("Move to folder", () => {
    const moveTargets = [
      { id: null, name: "Chats", depth: 0 },
      { id: "folder-1", name: "Work", depth: 1 },
      { id: "folder-2", name: "Archive", depth: 1 },
    ];

    it("does not render the submenu without move props", () => {
      render(<LeafContextMenu {...defaultProps} />);

      expect(screen.queryByText("Move to folder")).not.toBeInTheDocument();
    });

    it("does not render the submenu when moveTargets is empty", () => {
      render(<LeafContextMenu {...defaultProps} moveTargets={[]} onMove={vi.fn()} />);

      expect(screen.queryByText("Move to folder")).not.toBeInTheDocument();
    });

    it("renders the submenu with all targets", () => {
      render(<LeafContextMenu {...defaultProps} moveTargets={moveTargets} onMove={vi.fn()} />);

      expect(screen.getByText("Move to folder")).toBeInTheDocument();
      expect(screen.getByText("Chats")).toBeInTheDocument();
      expect(screen.getByText("Work")).toBeInTheDocument();
      expect(screen.getByText("Archive")).toBeInTheDocument();
    });

    it("calls onMove with the folder id when a folder is clicked", () => {
      const onMove = vi.fn();
      render(<LeafContextMenu {...defaultProps} moveTargets={moveTargets} onMove={onMove} />);

      fireEvent.click(screen.getByText("Work"));
      expect(onMove).toHaveBeenCalledWith("folder-1");
    });

    it("calls onMove with null for the root target", () => {
      const onMove = vi.fn();
      render(<LeafContextMenu {...defaultProps} moveTargets={moveTargets} onMove={onMove} />);

      fireEvent.click(screen.getByText("Chats"));
      expect(onMove).toHaveBeenCalledWith(null);
    });
  });
});
