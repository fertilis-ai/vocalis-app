import { Checkbox } from "@/components/ui/checkbox";
import type { ParamSpec } from "@/lib/engines/descriptors";
import { cn } from "@/lib/utils";

// Schema-driven engine parameter surface (spec §2.3): renders the active
// engine descriptor's ParamSpec list; values live with the tool page so they
// can be persisted into the run record.

interface ParamPanelProps {
  specs: ParamSpec[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
  className?: string;
}

export function ParamPanel({
  specs,
  values,
  onChange,
  disabled,
  className,
}: ParamPanelProps) {
  if (specs.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-end gap-x-5 gap-y-3", className)}>
      {specs.map((spec) => (
        <Param
          key={spec.key}
          spec={spec}
          value={values[spec.key] ?? spec.default}
          onChange={(value) => onChange(spec.key, value)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

function Param({
  spec,
  value,
  onChange,
  disabled,
}: {
  spec: ParamSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  switch (spec.type) {
    case "number": {
      const current = typeof value === "number" ? value : spec.default;
      return (
        <label className="flex flex-col gap-1 text-muted-foreground text-xs">
          <span>
            {spec.label}{" "}
            <span className="tabular-nums">
              ({current}
              {spec.unit ?? ""})
            </span>
          </span>
          <input
            type="range"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={current}
            disabled={disabled}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-36"
          />
        </label>
      );
    }
    case "boolean":
      return (
        <label className="flex items-center gap-2 pb-1 text-muted-foreground text-xs">
          <Checkbox
            checked={value === true}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(checked === true)}
          />
          {spec.label}
        </label>
      );
    case "select":
      return (
        <label className="flex flex-col gap-1 text-muted-foreground text-xs">
          {spec.label}
          <select
            value={typeof value === "string" ? value : spec.default}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {spec.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      );
  }
}
