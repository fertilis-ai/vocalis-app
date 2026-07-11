import { cn } from "@/lib/utils";

// Live input level bar fed by serialized Level events (rms/peak in 0..1
// sample amplitude) — the mic never streams raw audio to the webview.

interface LevelMeterProps {
  rms: number;
  peak: number;
  className?: string;
}

/** Perceptual-ish mapping: speech rms sits around 0.02–0.3 linear. */
function toFraction(value: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, value)) * 1.8);
}

export function LevelMeter({ rms, peak, className }: LevelMeterProps) {
  const level = toFraction(rms);
  const peakFraction = toFraction(peak);

  return (
    <div
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-muted",
        className,
      )}
      role="meter"
      aria-label="Input level"
      aria-valuenow={Math.round(level * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-75"
        style={{ width: `${level * 100}%` }}
      />
      <div
        className="absolute top-0 h-full w-0.5 bg-primary/60"
        style={{ left: `${peakFraction * 100}%` }}
      />
    </div>
  );
}
