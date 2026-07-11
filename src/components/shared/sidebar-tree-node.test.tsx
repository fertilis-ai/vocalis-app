import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  Plus: (props: any) => <span data-testid="icon-Plus" {...props}>Plus</span>,
  ChevronRight: (props: any) => (
    <span data-testid="icon-ChevronRight" {...props}>
      ChevronRight
    </span>
  ),
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
}));

// Mock the context menu to simplify testing the tree node
vi.mock("@/components/shared/item-context-menu", () => ({
  FolderContextMenu: ({
    onRename,
    onDelete,
    onTogglePin,
    isPinned,
  }: any) => (
    <div data-testid="folder-context-menu">
      <button onClick={onRename}>Rename</button>
      <button onClick={onDelete}>Delete</button>
      <button onClick={onTogglePin}>{isPinned ? "Unpin" : "Pin"}</button>
    </div>
  ),
  LeafContextMenu: ({ onRename, onDelete }: any) => (
    <div data-testid="leaf-context-menu">
      <button onClick={onRename}>Rename</button>
      <button onClick={onDelete}>Delete</button>
    </div>
  ),
}));

// Mock the Button component
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, title, ...props }: any) => (
    <button onClick={onClick} title={title} {...props}>
      {children}
    </button>
  ),
}));

import {
  SidebarTreeNode,
  type SidebarTreeNodeData,
} from "./sidebar-tree-node";

function createDefaultProps(overrides: Partial<Parameters<typeof SidebarTreeNode>[0]> = {}) {
  return {
    node: {
      type: "leaf",
      id: "leaf-1",
      name: "Test Leaf",
    } as SidebarTreeNodeData,
    depth: 0,
    selectedItemId: null,
    expandedFolders: new Set<string>(),
    editingId: null,
    editingName: "",
    leafIcon: <span data-testid="leaf-icon">icon</span>,
    leafType: "conversation",
    createInFolderTitle: "New conversation",
    onSelect: vi.fn(),
    onToggleExpand: vi.fn(),
    onCreateInFolder: vi.fn(),
    onStartEditing: vi.fn(),
    onEditingNameChange: vi.fn(),
    onKeyDown: vi.fn(),
    onRenameSubmit: vi.fn(),
    onDeleteFolder: vi.fn(),
    onDeleteLeaf: vi.fn(),
    onTogglePin: vi.fn(),
    getDisplayName: (node: SidebarTreeNodeData) => node.title || node.name,
    ...overrides,
  };
}

describe("SidebarTreeNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("leaf node rendering", () => {
    it("renders leaf node with display name", () => {
      const props = createDefaultProps();
      render(<SidebarTreeNode {...props} />);

      expect(screen.getByText("Test Leaf")).toBeInTheDocument();
    });

    it("renders leaf icon", () => {
      const props = createDefaultProps();
      render(<SidebarTreeNode {...props} />);

      expect(screen.getByTestId("leaf-icon")).toBeInTheDocument();
    });

    it("uses getDisplayName to determine display text", () => {
      const props = createDefaultProps({
        node: { type: "leaf", id: "leaf-1", name: "raw-name", title: "Pretty Title" },
      });
      render(<SidebarTreeNode {...props} />);

      expect(screen.getByText("Pretty Title")).toBeInTheDocument();
    });

    it("applies selected style when leaf is selected", () => {
      const props = createDefaultProps({ selectedItemId: "leaf-1" });
      const { container } = render(<SidebarTreeNode {...props} />);

      const node = container.firstChild as HTMLElement;
      expect(node.className).toContain("bg-muted");
    });

    it("does not apply selected style when a different item is selected", () => {
      const props = createDefaultProps({ selectedItemId: "other-id" });
      const { container } = render(<SidebarTreeNode {...props} />);

      const node = container.firstChild as HTMLElement;
      // The class list should not contain "bg-muted" as a standalone token
      // (it can contain "hover:bg-muted" which is fine)
      const classes = node.className.split(/\s+/);
      expect(classes).not.toContain("bg-muted");
    });

    it("calls onSelect when leaf is clicked", () => {
      const onSelect = vi.fn();
      const props = createDefaultProps({ onSelect });
      render(<SidebarTreeNode {...props} />);

      fireEvent.click(screen.getByText("Test Leaf"));
      expect(onSelect).toHaveBeenCalledWith("leaf-1");
    });

    it("renders leaf context menu", () => {
      const props = createDefaultProps();
      render(<SidebarTreeNode {...props} />);

      expect(screen.getByTestId("leaf-context-menu")).toBeInTheDocument();
    });

    it("calls onDeleteLeaf from context menu", () => {
      const onDeleteLeaf = vi.fn();
      const props = createDefaultProps({ onDeleteLeaf });
      render(<SidebarTreeNode {...props} />);

      fireEvent.click(screen.getByText("Delete"));
      expect(onDeleteLeaf).toHaveBeenCalledWith("leaf-1");
    });

    it("calls onStartEditing from context menu rename", () => {
      const onStartEditing = vi.fn();
      const props = createDefaultProps({ onStartEditing });
      render(<SidebarTreeNode {...props} />);

      fireEvent.click(screen.getByText("Rename"));
      expect(onStartEditing).toHaveBeenCalledWith("leaf-1", "Test Leaf", "conversation");
    });
  });

  describe("leaf node editing", () => {
    it("shows input when editingId matches leaf", () => {
      const props = createDefaultProps({
        editingId: "leaf-1",
        editingName: "Editing Value",
      });
      render(<SidebarTreeNode {...props} />);

      const input = screen.getByDisplayValue("Editing Value");
      expect(input).toBeInTheDocument();
      expect(input.tagName).toBe("INPUT");
    });

    it("calls onEditingNameChange when input value changes", () => {
      const onEditingNameChange = vi.fn();
      const props = createDefaultProps({
        editingId: "leaf-1",
        editingName: "Old",
        onEditingNameChange,
      });
      render(<SidebarTreeNode {...props} />);

      const input = screen.getByDisplayValue("Old");
      fireEvent.change(input, { target: { value: "New" } });
      expect(onEditingNameChange).toHaveBeenCalledWith("New");
    });

    it("calls onKeyDown when a key is pressed in input", () => {
      const onKeyDown = vi.fn();
      const props = createDefaultProps({
        editingId: "leaf-1",
        editingName: "test",
        onKeyDown,
      });
      render(<SidebarTreeNode {...props} />);

      const input = screen.getByDisplayValue("test");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onKeyDown).toHaveBeenCalled();
    });

    it("calls onRenameSubmit on blur", () => {
      const onRenameSubmit = vi.fn();
      const props = createDefaultProps({
        editingId: "leaf-1",
        editingName: "test",
        onRenameSubmit,
      });
      render(<SidebarTreeNode {...props} />);

      const input = screen.getByDisplayValue("test");
      fireEvent.blur(input);
      expect(onRenameSubmit).toHaveBeenCalled();
    });
  });

  describe("folder node rendering", () => {
    const folderNode: SidebarTreeNodeData = {
      type: "folder",
      id: "folder-1",
      name: "My Folder",
      isPinned: false,
      children: [
        { type: "leaf", id: "child-1", name: "Child 1" },
        { type: "leaf", id: "child-2", name: "Child 2" },
      ],
    };

    it("renders folder with display name", () => {
      const props = createDefaultProps({ node: folderNode });
      render(<SidebarTreeNode {...props} />);

      expect(screen.getByText("My Folder")).toBeInTheDocument();
    });

    it("does not render children when collapsed", () => {
      const props = createDefaultProps({ node: folderNode });
      render(<SidebarTreeNode {...props} />);

      expect(screen.queryByText("Child 1")).not.toBeInTheDocument();
      expect(screen.queryByText("Child 2")).not.toBeInTheDocument();
    });

    it("renders children when expanded", () => {
      const props = createDefaultProps({
        node: folderNode,
        expandedFolders: new Set(["folder-1"]),
      });
      render(<SidebarTreeNode {...props} />);

      expect(screen.getByText("Child 1")).toBeInTheDocument();
      expect(screen.getByText("Child 2")).toBeInTheDocument();
    });

    it("calls onToggleExpand when chevron is clicked", () => {
      const onToggleExpand = vi.fn();
      const props = createDefaultProps({ node: folderNode, onToggleExpand });
      render(<SidebarTreeNode {...props} />);

      // The chevron button is the first button inside the folder row
      const chevronButton = screen.getByTestId("icon-ChevronRight").closest("button")!;
      fireEvent.click(chevronButton);
      expect(onToggleExpand).toHaveBeenCalledWith("folder-1");
    });

    it("calls onToggleExpand when folder name span is clicked", () => {
      const onToggleExpand = vi.fn();
      const props = createDefaultProps({ node: folderNode, onToggleExpand });
      render(<SidebarTreeNode {...props} />);

      fireEvent.click(screen.getByText("My Folder"));
      expect(onToggleExpand).toHaveBeenCalledWith("folder-1");
    });

    it("renders folder context menu", () => {
      const props = createDefaultProps({ node: folderNode });
      render(<SidebarTreeNode {...props} />);

      expect(screen.getByTestId("folder-context-menu")).toBeInTheDocument();
    });

    it("calls onDeleteFolder from context menu", () => {
      const onDeleteFolder = vi.fn();
      const props = createDefaultProps({ node: folderNode, onDeleteFolder });
      render(<SidebarTreeNode {...props} />);

      fireEvent.click(screen.getByText("Delete"));
      expect(onDeleteFolder).toHaveBeenCalledWith("folder-1");
    });

    it("calls onTogglePin from context menu", () => {
      const onTogglePin = vi.fn();
      const props = createDefaultProps({ node: folderNode, onTogglePin });
      render(<SidebarTreeNode {...props} />);

      fireEvent.click(screen.getByText("Pin"));
      expect(onTogglePin).toHaveBeenCalledWith("folder-1");
    });

    it("shows Unpin label when folder is pinned", () => {
      const pinnedFolder = { ...folderNode, isPinned: true };
      const props = createDefaultProps({ node: pinnedFolder });
      render(<SidebarTreeNode {...props} />);

      expect(screen.getByText("Unpin")).toBeInTheDocument();
    });

    it("renders create-in-folder button with title", () => {
      const props = createDefaultProps({ node: folderNode });
      render(<SidebarTreeNode {...props} />);

      expect(screen.getByTitle("New conversation")).toBeInTheDocument();
    });

    it("calls onCreateInFolder when plus button clicked (already expanded)", () => {
      const onCreateInFolder = vi.fn();
      const onToggleExpand = vi.fn();
      const props = createDefaultProps({
        node: folderNode,
        expandedFolders: new Set(["folder-1"]),
        onCreateInFolder,
        onToggleExpand,
      });
      render(<SidebarTreeNode {...props} />);

      fireEvent.click(screen.getByTitle("New conversation"));
      expect(onCreateInFolder).toHaveBeenCalledWith("folder-1");
      // Should NOT call onToggleExpand since already expanded
      expect(onToggleExpand).not.toHaveBeenCalled();
    });

    it("expands folder and creates in folder when plus clicked on collapsed folder", () => {
      const onCreateInFolder = vi.fn();
      const onToggleExpand = vi.fn();
      const props = createDefaultProps({
        node: folderNode,
        onCreateInFolder,
        onToggleExpand,
      });
      render(<SidebarTreeNode {...props} />);

      fireEvent.click(screen.getByTitle("New conversation"));
      expect(onToggleExpand).toHaveBeenCalledWith("folder-1");
      expect(onCreateInFolder).toHaveBeenCalledWith("folder-1");
    });
  });

  describe("folder node editing", () => {
    const folderNode: SidebarTreeNodeData = {
      type: "folder",
      id: "folder-1",
      name: "My Folder",
      children: [],
    };

    it("shows input when editingId matches folder", () => {
      const props = createDefaultProps({
        node: folderNode,
        editingId: "folder-1",
        editingName: "Renaming Folder",
      });
      render(<SidebarTreeNode {...props} />);

      const input = screen.getByDisplayValue("Renaming Folder");
      expect(input).toBeInTheDocument();
    });

    it("calls onRenameSubmit on folder input blur", () => {
      const onRenameSubmit = vi.fn();
      const props = createDefaultProps({
        node: folderNode,
        editingId: "folder-1",
        editingName: "test",
        onRenameSubmit,
      });
      render(<SidebarTreeNode {...props} />);

      const input = screen.getByDisplayValue("test");
      fireEvent.blur(input);
      expect(onRenameSubmit).toHaveBeenCalled();
    });
  });

  describe("indentation", () => {
    it("applies correct padding for depth 0", () => {
      const props = createDefaultProps({ depth: 0 });
      const { container } = render(<SidebarTreeNode {...props} />);

      const node = container.firstChild as HTMLElement;
      expect(node.style.paddingLeft).toBe("8px");
    });

    it("applies correct padding for depth 2", () => {
      const props = createDefaultProps({ depth: 2 });
      const { container } = render(<SidebarTreeNode {...props} />);

      const node = container.firstChild as HTMLElement;
      // baseIndent(8) + depth(2) * indentStep(24) = 56
      expect(node.style.paddingLeft).toBe("56px");
    });
  });

  describe("folder does not get selected style", () => {
    it("folder is never 'selected' even if selectedItemId matches", () => {
      const folderNode: SidebarTreeNodeData = {
        type: "folder",
        id: "folder-1",
        name: "Folder",
        children: [],
      };
      const props = createDefaultProps({
        node: folderNode,
        selectedItemId: "folder-1",
      });
      const { container } = render(<SidebarTreeNode {...props} />);

      // Folder should not have bg-muted applied as a selection class
      // (the outer div doesn't have the isSelected logic)
      const folderDiv = container.querySelector("[style]") as HTMLElement;
      const classes = folderDiv.className.split(/\s+/);
      expect(classes).not.toContain("bg-muted");
    });
  });
});
