interface PlaceholderViewProps {
  title: string;
  description: string;
}

export function PlaceholderView({ title, description }: PlaceholderViewProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <h1 className="font-semibold text-2xl text-foreground">{title}</h1>
      <p className="max-w-md text-muted-foreground text-sm">{description}</p>
    </div>
  );
}

export function PlaceholderSidebar({ title }: { title: string }) {
  return (
    <div className="flex h-full flex-col p-3">
      <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {title}
      </span>
    </div>
  );
}
