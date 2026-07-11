import * as React from "react";
import { cn } from "@/lib/utils";

interface ResizablePaneProps {
  children: React.ReactNode;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  className?: string;
  onWidthChange?: (width: number) => void;
}

export function ResizablePane({
  children,
  defaultWidth = 250,
  minWidth = 150,
  maxWidth = 500,
  className,
  onWidthChange,
}: ResizablePaneProps) {
  const [width, setWidth] = React.useState(defaultWidth);
  const [isResizing, setIsResizing] = React.useState(false);
  const paneRef = React.useRef<HTMLDivElement>(null);
  const widthRef = React.useRef(width);

  // Keep ref in sync with state
  React.useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const handleMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  React.useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!paneRef.current) return;
      const paneRect = paneRef.current.getBoundingClientRect();
      const newWidth = e.clientX - paneRect.left;
      const clampedWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
      setWidth(clampedWidth);
      widthRef.current = clampedWidth;
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      // Persist the final width using ref to get current value
      onWidthChange?.(widthRef.current);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, minWidth, maxWidth, onWidthChange]);

  return (
    <div
      ref={paneRef}
      className={cn("relative flex-shrink-0 border-r border-border bg-sidebar", className)}
      style={{ width }}
    >
      <div className="h-full overflow-auto">{children}</div>
      <div
        className={cn(
          "absolute right-0 top-0 h-full w-1 cursor-col-resize transition-colors hover:bg-primary/50",
          isResizing && "bg-primary/50"
        )}
        onMouseDown={handleMouseDown}
      />
    </div>
  );
}
